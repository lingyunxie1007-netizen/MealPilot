import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { Store } from "../src/storage/store.ts";

// 独立 schema 允许本用例验证真实行锁，清理范围仅限本次运行。
test(
  "PostgreSQL 保证消息、版本和交易提交的一致性",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "mealpilot_test_" + randomUUID().replaceAll("-", "");
    const connectionString = process.env.TEST_DATABASE_URL;
    const admin = new Pool({ connectionString });
    const pool = new Pool({
      connectionString,
      options: "-c search_path=" + schema,
    });
    try {
      await admin.query("CREATE SCHEMA " + schema);
      const store = new Store(pool);
      await store.init();
      const id = await store.createConversation("alice");
      const submit = () =>
        store.submitMessage("alice", id, "first", "推荐早餐");
      const [first, second] = await Promise.all([submit(), submit()]);
      assert.equal(first.runId, second.runId);
      assert.notEqual(first.created, second.created);
      assert.equal((await store.history("alice", id)).length, 1);
      await assert.rejects(store.events("bob", first.runId), {
        statusCode: 404,
      });
      await Promise.all(
        [1, 2].map((n) =>
          store.appendEvent("alice", first.runId, "text_delta", {
            text: String(n),
          }),
        ),
      );
      assert.deepEqual(
        (await store.events("alice", first.runId)).map((e) => e.seq),
        [1, 2],
      );

      const draft = await store.saveDraft("alice", id, null, 0, {
        meal: "早餐",
      });
      const action = await store.prepareAction(
        "alice",
        id,
        "create-order",
        {},
        1,
        "q1",
        draft.draftId,
      );
      const claim = () => store.claimAction("alice", action.actionId, 1, "q1");
      await assert.rejects(store.claimAction("bob", action.actionId, 1, "q1"), {
        statusCode: 404,
      });
      await assert.rejects(
        store.claimAction("alice", action.actionId, 1, "q2"),
        { statusCode: 409 },
      );
      assert.deepEqual(
        (await Promise.all([claim(), claim()])).map((r) => r.claimed).sort(),
        [false, true],
      );
      await store.recoverInterrupted();
      assert.equal((await claim()).action.status, "unknown");
      assert.equal(
        (await store.events("alice", first.runId, 2))[0]?.type,
        "run_failed",
      );

      const stale = await store.prepareAction(
        "alice",
        id,
        "create-order",
        {},
        1,
        "q1",
        draft.draftId,
      );
      const revise = () =>
        store.saveDraft("alice", id, draft.draftId, 1, { meal: "夜宵" });
      const revisions = await Promise.allSettled([revise(), revise()]);
      assert.equal(
        revisions.filter((row) => row.status === "fulfilled").length,
        1,
      );
      await assert.rejects(
        store.claimAction("alice", stale.actionId, 1, "q1"),
        { statusCode: 409 },
      );
      assert.deepEqual((await store.getDraft("alice", draft.draftId, 1)).data, {
        meal: "早餐",
      });
      assert.deepEqual((await store.getDraft("alice", draft.draftId)).data, {
        meal: "夜宵",
      });
    } finally {
      await pool.end();
      try {
        await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      } finally {
        await admin.end();
      }
    }
  },
);
