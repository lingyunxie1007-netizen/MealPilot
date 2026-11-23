import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createMealAgent } from "./agent/index.ts";
import type { Store } from "./storage/store.ts";
import { nearbyQuery, type business, type User } from "./graphs/business.ts";

type Account = User & { apiKey: string };
declare module "fastify" {
  interface FastifyContextConfig {
    publicAsset?: boolean;
  }
}
const digest = (key: string) => createHash("sha256").update(key).digest();
const idParam = z.object({ id: z.uuid() });
export const accountsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      apiKey: z.string().min(20),
      token: z.string().min(1),
    }),
  )
  .min(1)
  .refine(
    (list) =>
      new Set(list.map((a) => a.id)).size === list.length &&
      new Set(list.map((a) => a.apiKey)).size === list.length,
    "账户或密钥重复",
  );

export function createApi(
  store: Store,
  service: ReturnType<typeof business>,
  accounts: Account[],
  makeAgent = createMealAgent,
) {
  const app = Fastify({ bodyLimit: 64 * 1024 });
  const users = new WeakMap<object, User>();
  const active = new Map<
    string,
    { steer(text: string): void; runs: string[] }
  >();
  const locks = new Map<string, Promise<unknown>>();
  // 按会话串行接收消息，确保同一个进程中只有一个 Pi 循环消费插话。
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = (locks.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    locks.set(key, pending);
    return pending.finally(() => {
      if (locks.get(key) === pending) locks.delete(key);
    });
  }
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.config?.publicAsset === true) return;
    const header = req.headers.authorization ?? "";
    const account = accounts.find((a) =>
      timingSafeEqual(digest("Bearer " + a.apiKey), digest(header)),
    );
    if (!account) return reply.code(401).send({ error: "需要有效的访问密钥" });
    users.set(req, account);
  });
  // 路由和文件名都来自固定清单。
  for (const [path, filename, mime] of [
    ["/", "index.html", "text/html"],
    ["/style.css", "style.css", "text/css"],
    ["/app.js", "app.js", "text/javascript"],
    ["/cards.js", "cards.js", "text/javascript"],
    ["/location.js", "location.js", "text/javascript"],
  ] as const) {
    const asset = new URL("../web/" + filename, import.meta.url);
    app.get(path, { config: { publicAsset: true }, exposeHeadRoute: false }, async (_req, reply) =>
      reply.type(mime + "; charset=utf-8").send(await readFile(asset)),
    );
  }
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : (err.statusCode ?? 500);
    reply
      .code(status)
      .send({
        error: status >= 500 ? "服务处理失败" : err.message,
        ...(status === 409
          ? { draftId: err.draftId, version: err.version, quoteId: err.quoteId }
          : {}),
      });
  });
  app.post("/stores/nearby", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const input = nearbyQuery.safeParse(req.body);
    if (!input.success) {
      return reply.code(400).send({ error: "请检查门店类型、城市和关键词，或重新获取定位。" });
    }
    try {
      return await service.nearby(users.get(req)!, input.data);
    } catch {
      return reply.code(502).send({ error: "暂时无法查询门店，请稍后再试。" });
    }
  });
  app.post("/conversations", async (req) => ({
    conversationId: await store.createConversation(users.get(req)!.id),
  }));
  app.post("/conversations/:id/messages", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = users.get(req)!;
    const body = z
      .object({
        clientMessageId: z.string().min(1).max(150),
        text: z.string().trim().min(1).max(12000),
        draftId: z.uuid().optional(),
      })
      .parse(req.body);
    return serial(id, async () => {
      const history = await store.history(user.id, id);
      const { runId, created } = await store.submitMessage(
        user.id,
        id,
        body.clientMessageId,
        body.text,
        body.draftId,
      );
      if (!created) return { runId };
      const text = body.draftId
        ? body.text + "\n当前选择的草稿 ID " + body.draftId
        : body.text;
      const current = active.get(id);
      if (current) {
        current.runs.push(runId);
        current.steer(text);
        return reply.code(202).send({ runId });
      }
      const runs = [runId];
      let writing = Promise.resolve();
      function emit(type: string, data: object) {
        const recipients = [...runs];
        writing = writing.then(async () => {
          await Promise.all(
            recipients.map((r) => store.appendEvent(user.id, r, type, data)),
          );
        });
        void writing.catch(() => {});
      }
      const agent = makeAgent({
        history: history.slice(-50),
        emit,
        execute: async (name, args) => {
          const result = await service.execute(user, id, name, args);
          if (name === "prepare_action") emit("confirmation_required", result);
          if (name === "find_meal_options" || name === "revise_meal")
            emit("draft_ready", result);
          return result;
        },
      });
      active.set(id, { steer: agent.steer, runs });
      // 完整回复与终态持久化后，重连客户端可以按事件序号继续读取。
      void (async () => {
        try {
          const answer = await agent.prompt(text);
          active.delete(id);
          await writing;
          await store.appendAssistant(
            user.id,
            id,
            answer,
            runs[runs.length - 1],
          );
          for (const r of runs)
            await store.appendEvent(user.id, r, "run_completed", {
              text: answer,
            });
        } catch {
          if (active.get(id)?.runs === runs) active.delete(id);
          await writing.catch(() => {});
          for (const r of runs)
            await store.appendEvent(user.id, r, "run_failed", {
              message: "运行失败，请检查模型、MCP 凭据及服务状态",
            });
        }
      })().catch(() => app.log.error("运行状态持久化失败"));
      return reply.code(202).send({ runId });
    });
  });
  app.get("/runs/:id/events", async (req, reply) => {
    const { id } = idParam.parse(req.params),
      user = users.get(req)!;
    let after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(req.headers["last-event-id"] ?? 0);
    let batch = await store.events(user.id, id, after);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    reply.raw.write(": connected\n\n");
    try {
      while (!reply.raw.destroyed) {
        for (const e of batch) {
          after = e.seq;
          reply.raw.write(
            "id: " +
              e.seq +
              "\nevent: " +
              e.type +
              "\ndata: " +
              JSON.stringify({ runId: id, seq: e.seq, ...e.data }) +
              "\n\n",
          );
          if (["run_completed", "run_failed"].includes(e.type)) return;
        }
        if (
          !batch.length &&
          after > 0 &&
          (await store.events(user.id, id, after - 1)).some(
            (e) =>
              e.seq === after &&
              ["run_completed", "run_failed"].includes(e.type),
          )
        )
          return;
        await sleep(400);
        batch = await store.events(user.id, id, after);
      }
    } finally {
      reply.raw.end();
    }
  });
  app.get("/drafts/:id", async (req) =>
    store.getDraft(users.get(req)!.id, idParam.parse(req.params).id),
  );
  app.get("/actions/:id", async (req) =>
    store.getAction(users.get(req)!.id, idParam.parse(req.params).id),
  );
  app.post("/actions/:id/confirm", async (req) => {
    const { id } = idParam.parse(req.params),
      user = users.get(req)!;
    const body = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        quoteId: z.string().nullable(),
      })
      .parse(req.body);
    return serial("confirm/" + id, () =>
      service.confirm(user, id, body.expectedVersion, body.quoteId),
    );
  });
  return app;
}
