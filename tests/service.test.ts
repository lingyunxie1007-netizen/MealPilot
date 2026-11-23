import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Store } from "../src/storage/store.ts";
import { createApi } from "../src/api.ts";
import { business } from "../src/graphs/business.ts";
import type { connectMcd } from "../src/integrations/mcd/index.ts";

test(
  "HTTP 预览、用户隔离、报价变化与重试确认（真实 PostgreSQL 检查点）",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const owner = randomUUID();
    const headers = { authorization: "Bearer " + owner };
    const saver = new PostgresSaver(pool);
    const store = new Store(pool);
    let cents = 2100,
      writes = 0;
    // 替代外部供应商，覆盖价格在用户确认之前发生变化的路径。
    const connect = async () => ({
      tools: {
        "create-order": {
          name: "create-order",
          inputSchema: { type: "object" as const },
        },
      },
      close: async () => {},
      call: async (name: string) => {
        if (name === "calculate-price")
          return { price: cents, deliveryPrice: 0, productList: [] };
        if (name === "create-order") {
          writes++;
          return { orderId: "test-order" };
        }
        throw new Error("未知测试工具");
      },
    });
    const service = business({
      store,
      saver,
      connect: connect as unknown as typeof connectMcd,
    });
    const user = { id: owner, apiKey: owner, token: "test-token" };
    const app = createApi(store, service, [user], ({ emit }) => ({
      async prompt() {
        emit("text_delta", { text: "早餐", delta: "早餐" });
        return "早餐";
      },
      steer() {},
    }));
    try {
      await store.init();
      await saver.setup();
      const created = await app.inject({
        method: "POST",
        url: "/conversations",
        headers,
      });
      assert.equal(created.statusCode, 200);
      const conversation = created.json().conversationId;
      const message = await app.inject({
        method: "POST",
        url: "/conversations/" + conversation + "/messages",
        headers,
        payload: { clientMessageId: "http-test", text: "查早餐" },
      });
      assert.equal(message.statusCode, 202);
      const stream = await app.inject({
        url: "/runs/" + message.json().runId + "/events",
        headers,
      });
      assert.match(stream.body, /event: text_delta/);
      assert.match(stream.body, /event: run_completed/);
      const prepare = () =>
        service.execute(user, conversation, "prepare_action", {
          name: "create-order",
          arguments: {
            storeCode: "test",
            items: [{ productCode: "test", quantity: 1 }],
          },
        });
      const first = await prepare();
      const confirm = (a: any) =>
        app.inject({
          method: "POST",
          url: "/actions/" + a.actionId + "/confirm",
          headers,
          payload: { expectedVersion: a.expectedVersion, quoteId: a.quoteId },
        });
      assert.equal(
        (await app.inject({ url: "/actions/" + first.actionId })).statusCode,
        401,
      );
      cents = 2150;
      assert.equal((await confirm(first)).json().status, "failed");
      assert.equal(writes, 0);
      const second = await prepare();
      const replies = await Promise.all([confirm(second), confirm(second)]);
      assert.deepEqual(
        replies.map((r) => r.json().status),
        ["succeeded", "succeeded"],
      );
      assert.equal(writes, 1);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
