import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { createApprovalFlow } from "./approval.ts";
import { recommend } from "../domain/meals/index.ts";
import { connectMcd, isWriteTool } from "../integrations/mcd/index.ts";
import type { Store, Action } from "../storage/store.ts";

type Inputs = Record<string, any>;
type Connection = Awaited<ReturnType<typeof connectMcd>>;
export type User = { id: string; token: string };
const beType = z.union([z.literal(1), z.literal(5)]);
export const nearbyQuery = z.discriminatedUnion("searchType", [
  z.strictObject({
    beType, searchType: z.literal(2),
    city: z.string().trim().min(1), keyword: z.string().trim().min(1),
  }),
  z.strictObject({
    beType, searchType: z.literal(3),
    longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90),
  }),
]);
const storeValue = z.union([z.string(), z.number()]);
const nearbyStores = z.array(z.object({
  storeCode: storeValue, storeName: z.string(), address: z.string().nullish(),
  distance: storeValue.nullish(), businessStatus: z.union([z.boolean(), storeValue]).nullish(),
}));
type Dependencies = {
  store: Store;
  saver: BaseCheckpointSaver;
  connect?: typeof connectMcd;
};
export function business({ store, saver, connect = connectMcd }: Dependencies) {
  async function withMcd<T>(user: User, work: (mcd: Connection) => Promise<T>) {
    const mcd = await connect(user.token);
    try {
      return await work(mcd);
    } finally {
      await mcd.close().catch(() => {});
    }
  }
  async function price(mcd: Connection, args: Inputs) {
    // 下单参数包含地址和备注，算价接口只接收自己的字段。
    const keys = [
      "storeCode",
      "beCode",
      "orderType",
      "beType",
      "reservationDate",
      "gmServiceCode",
      "withOrder",
      "needTableware",
      "items",
    ];
    const params = Object.fromEntries(
      keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]),
    );
    const quote = await mcd.call("calculate-price", params);
    if (!Number.isSafeInteger(quote?.price) || quote.price < 0)
      throw new Error("未取得有效实付金额");
    return {
      amountCents: quote.price,
      deliveryCents: quote.deliveryPrice ?? null,
      items: quote.productList ?? [],
      takeWayList: quote.takeWayList ?? [],
    };
  }
  function approval(
    user: User,
    expectedVersion: number,
    quoteId: string | null,
  ) {
    return createApprovalFlow(saver, async (id) => {
      const { claimed, action } = await store.claimAction(
        user.id,
        id,
        expectedVersion,
        quoteId,
      );
      if (!claimed) return;
      let sent = false;
      try {
        const result = await withMcd(user, async (mcd) => {
          if (
            action.kind === "create-order" &&
            !isDeepStrictEqual(
              action.payload.quote,
              await price(mcd, action.payload.arguments),
            )
          )
            throw new Error("报价已变化，请重新生成预览");
          sent = true;
          return mcd.call(action.kind, action.payload.arguments);
        });
        await store.finishAction(user.id, id, "succeeded", {
          providerResult: result,
        });
      } catch (e) {
        // 请求可能已到达供应商。保留未知状态，重试同一确认不会再次扣减。
        await store.finishAction(user.id, id, sent ? "unknown" : "failed", {
          message: sent
            ? "请通过对应订单或权益记录核对结果"
            : String((e as Error).message),
        });
      }
    });
  }
  return {
    async nearby(user: User, query: z.infer<typeof nearbyQuery>) {
      return withMcd(user, async (mcd) => {
        const result = await mcd.call("query-nearby-stores", query);
        return nearbyStores.parse(result);
      });
    },
    async execute(
      user: User,
      conversation: string,
      tool: string,
      input: Inputs,
    ) {
      const readDraft = async (id: string) => {
        const draft = await store.getDraft(user.id, id);
        if (draft.conversationId !== conversation)
          throw new Error("草稿不属于此会话");
        return draft;
      };
      if (tool === "compare_drafts")
        return Promise.all(input.draftIds.map(readDraft));
      if (tool === "query_service")
        return withMcd(user, (mcd) => {
          if (input.name === "list_tools")
            return Promise.resolve(
              Object.values(mcd.tools).map((t) => ({
                name: t.name,
                inputSchema: t.inputSchema,
              })),
            );
          if (isWriteTool(input.name)) throw new Error("写操作需要准备预览");
          return mcd.call(input.name, input.arguments);
        });
      if (tool === "prepare_action") {
        if (!isWriteTool(input.name)) throw new Error("未知写操作");
        if (input.draftId && input.name === "create-order") {
          const draft = await readDraft(input.draftId);
          const context = draft.data.context ?? {};
          const matchesContext = [
            "storeCode",
            "beCode",
            "beType",
            "orderType",
            "reservationDate",
          ].every(
            (key) =>
              String(input.arguments[key] ?? "") === String(context[key] ?? ""),
          );
          const matchesItems = draft.data.candidates.some((candidate: Inputs) =>
            isDeepStrictEqual(candidate.items, input.arguments.items),
          );
          if (!context.storeCode || !matchesContext || !matchesItems)
            throw new Error(
              "订单与已核价草稿的门店、时段或商品不符，请先修改草稿",
            );
        }
        const preview = await withMcd(user, async (mcd) => {
          if (!mcd.tools[input.name]) throw new Error("当前账户缺少权限");
          return {
            arguments: input.arguments,
            quote:
              input.name === "create-order"
                ? await price(mcd, input.arguments)
                : null,
          };
        });
        const quoteId = preview.quote ? randomUUID() : null;
        const version = input.version ?? 0;
        const action = await store.prepareAction(
          user.id,
          conversation,
          input.name,
          preview,
          version,
          quoteId,
          input.draftId ?? null,
        );
        await approval(user, version, quoteId).prepare(action.actionId);
        return action;
      }
      if (tool !== "find_meal_options" && tool !== "revise_meal")
        throw new Error("未知业务工具");
      const previous =
        tool === "revise_meal" ? await readDraft(input.draftId) : null;
      if (previous && previous.version !== input.expectedVersion)
        throw new Error("草稿版本已过期");
      const { draftId, expectedVersion, ...changes } = input;
      const requirements = { ...previous?.data.requirements, ...changes };
      const S = Annotation.Root({
        result: Annotation<Inputs>(),
        draft: Annotation<Inputs>(),
      });
      // 查询与保存分为两个节点。保存时比较调用开始时的版本，避免覆盖并发修改。
      const graph = new StateGraph(S)
        .addNode("recommend", async () => ({
          result: await withMcd(user, (m) => recommend(m.call, requirements)),
        }))
        .addNode("save", async ({ result }) => ({
          draft: await store.saveDraft(
            user.id,
            conversation,
            previous?.draftId ?? null,
            previous?.version ?? 0,
            { requirements, ...result },
          ),
        }))
        .addEdge(START, "recommend")
        .addEdge("recommend", "save")
        .addEdge("save", END)
        .compile();
      return (await graph.invoke({})).draft;
    },
    async confirm(
      user: User,
      id: string,
      version: number,
      quoteId: string | null,
    ): Promise<Action> {
      const action = await store.getAction(user.id, id);
      if (action.expectedVersion !== version || action.quoteId !== quoteId)
        throw Object.assign(new Error("确认版本与预览不符"), {
          statusCode: 409,
        });
      if (action.status === "pending")
        await approval(user, version, quoteId).confirm(id);
      return store.getAction(user.id, id);
    },
  };
}
