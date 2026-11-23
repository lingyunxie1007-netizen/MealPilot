import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;
type Json = Record<string, any>;
export interface Action {
  actionId: string;
  userId: string;
  conversationId: string;
  kind: string;
  payload: Json;
  expectedVersion: number;
  quoteId: string | null;
  draftId: string | null;
  status: "pending" | "submitting" | "unknown" | "failed" | "succeeded";
  result: Json | null;
}
function error(statusCode: number, message: string, details: object = {}) {
  return Object.assign(new Error(message), { statusCode, ...details });
}
async function one<T = Json>(db: Db, sql: string, args: unknown[]): Promise<T> {
  const { rows } = await db.query(sql, args);
  if (!rows.length) throw error(404, "未找到记录");
  return rows[0] as T;
}
const actionSql = `SELECT a.id AS "actionId", c.owner AS "userId", c.id AS "conversationId",
 a.kind,a.payload,a.expected_version AS "expectedVersion",a.quote_id AS "quoteId",
 a.draft AS "draftId",a.status,a.result FROM mp_action a JOIN mp_conversation c
 ON c.id=a.conversation WHERE c.owner=$1 AND a.id=$2`;

export class Store {
  constructor(readonly pool: Pool) {}
  async init() {
    const sql = await readFile(
      new URL("./schema.sql", import.meta.url),
      "utf8",
    );
    await this.pool.query(sql.replace(/^\uFEFF/, ""));
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const value = await work(db);
      await db.query("COMMIT");
      return value;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  // 单实例启动时调用。已获得提交权的交易可能已经到达远端。
  async recoverInterrupted() {
    await this.tx(async (db) => {
      await db.query(
        "UPDATE mp_action SET status='unknown' WHERE status='submitting'",
      );
      await db.query(`WITH interrupted AS (
        UPDATE mp_run SET terminal=true,seq=seq+1 WHERE NOT terminal RETURNING id,seq
      ) INSERT INTO mp_event SELECT id,seq,'run_failed','{"message":"服务已重启"}'::jsonb FROM interrupted`);
    });
  }
  async createConversation(userId: string) {
    const id = randomUUID();
    await this.pool.query("INSERT INTO mp_conversation VALUES ($1,$2)", [
      id,
      userId,
    ]);
    return id;
  }
  async submitMessage(
    userId: string,
    conversationId: string,
    clientMessageId: string,
    text: string,
    draftId?: string | null,
  ) {
    return this.tx(async (db) => {
      await one(db, "SELECT id FROM mp_conversation WHERE owner=$1 AND id=$2", [
        userId,
        conversationId,
      ]);
      if (draftId)
        await one(
          db,
          "SELECT id FROM mp_draft WHERE conversation=$1 AND id=$2",
          [conversationId, draftId],
        );
      const runId = randomUUID();
      const inserted = await db.query(
        `INSERT INTO mp_run(id,conversation,client_id,draft) VALUES ($1,$2,$3,$4)
        ON CONFLICT(conversation,client_id) DO NOTHING`,
        [runId, conversationId, clientMessageId, draftId],
      );
      if (!inserted.rowCount) {
        const previous = await one(
          db,
          `SELECT r.id,m.content,r.draft FROM mp_run r JOIN mp_message m ON m.run=r.id
          WHERE r.conversation=$1 AND r.client_id=$2 AND m.role='user'`,
          [conversationId, clientMessageId],
        );
        if (previous.content !== text || previous.draft !== (draftId ?? null))
          throw error(409, "消息标识已用于其他内容");
        return { runId: String(previous.id), created: false };
      }
      await db.query(
        "INSERT INTO mp_message(run,role,content) VALUES ($1,'user',$2)",
        [runId, text],
      );
      return { runId, created: true };
    });
  }
  async history(userId: string, conversationId: string) {
    await one(
      this.pool,
      "SELECT id FROM mp_conversation WHERE owner=$1 AND id=$2",
      [userId, conversationId],
    );
    return (
      await this.pool.query<{ role: "user" | "assistant"; content: string }>(
        `SELECT m.role,m.content FROM mp_message m
      JOIN mp_run r ON r.id=m.run WHERE r.conversation=$1 ORDER BY m.seq`,
        [conversationId],
      )
    ).rows;
  }
  async appendAssistant(
    userId: string,
    conversationId: string,
    content: string,
    runId: string,
  ) {
    await one(
      this.pool,
      `INSERT INTO mp_message(run,role,content)
      SELECT r.id,'assistant',$3 FROM mp_run r JOIN mp_conversation c ON c.id=r.conversation
      WHERE c.owner=$1 AND c.id=$2 AND r.id=$4 ON CONFLICT(run,role) DO UPDATE SET content=mp_message.content RETURNING seq`,
      [userId, conversationId, content, runId],
    );
  }
  async appendEvent(userId: string, runId: string, type: string, data: object) {
    return one(
      this.pool,
      `WITH advanced AS (
      UPDATE mp_run r SET seq=seq+1,terminal=($3 IN ('run_completed','run_failed'))
      FROM mp_conversation c WHERE c.id=r.conversation AND c.owner=$1 AND r.id=$2 AND NOT r.terminal RETURNING r.seq,r.id
    ) INSERT INTO mp_event SELECT id,seq,$3,$4::jsonb FROM advanced RETURNING seq,type,data`,
      [userId, runId, type, JSON.stringify(data)],
    );
  }
  async events(userId: string, runId: string, after = 0) {
    await one(
      this.pool,
      `SELECT r.id FROM mp_run r JOIN mp_conversation c ON c.id=r.conversation
      WHERE c.owner=$1 AND r.id=$2`,
      [userId, runId],
    );
    return (
      await this.pool.query<{ seq: number; type: string; data: Json }>(
        "SELECT seq,type,data FROM mp_event WHERE run=$1 AND seq>$2 ORDER BY seq",
        [runId, after],
      )
    ).rows;
  }
  async saveDraft(
    userId: string,
    conversationId: string,
    draftId: string | null,
    expectedVersion: number,
    data: object,
    parentDraftId?: string,
  ) {
    return this.tx(async (db) => {
      await one(db, "SELECT id FROM mp_conversation WHERE owner=$1 AND id=$2", [
        userId,
        conversationId,
      ]);
      if (!draftId || expectedVersion === 0) {
        draftId ??= randomUUID();
        if (parentDraftId)
          await one(
            db,
            "SELECT id FROM mp_draft WHERE id=$1 AND conversation=$2",
            [parentDraftId, conversationId],
          );
        await db.query(
          "INSERT INTO mp_draft(id,conversation,parent) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [draftId, conversationId, parentDraftId],
        );
      }
      const current = await one(
        db,
        "SELECT version FROM mp_draft WHERE id=$1 AND conversation=$2 FOR UPDATE",
        [draftId, conversationId],
      );
      if (current.version !== expectedVersion)
        throw error(409, "草稿版本已变化", {
          draftId,
          version: current.version,
        });
      const version = expectedVersion + 1;
      await db.query("UPDATE mp_draft SET version=$2 WHERE id=$1", [
        draftId,
        version,
      ]);
      await db.query("INSERT INTO mp_revision VALUES ($1,$2,$3)", [
        draftId,
        version,
        JSON.stringify(data),
      ]);
      return { draftId, version, data };
    });
  }
  async getDraft(userId: string, draftId: string, version?: number) {
    return one(
      this.pool,
      `SELECT d.id AS "draftId",d.conversation AS "conversationId",d.parent AS "parentDraftId",r.version,r.data
      FROM mp_draft d JOIN mp_conversation c ON c.id=d.conversation JOIN mp_revision r ON r.draft=d.id
      WHERE c.owner=$1 AND d.id=$2 AND r.version=COALESCE($3,d.version)`,
      [userId, draftId, version],
    );
  }
  async prepareAction(
    userId: string,
    conversationId: string,
    kind: string,
    payload: object,
    expectedVersion: number,
    quoteId: string | null,
    draftId: string | null,
    actionId: string = randomUUID(),
  ) {
    return this.tx(async (db) => {
      await one(db, "SELECT id FROM mp_conversation WHERE owner=$1 AND id=$2", [
        userId,
        conversationId,
      ]);
      if (draftId) {
        const draft = await one(
          db,
          "SELECT version FROM mp_draft WHERE id=$1 AND conversation=$2 FOR SHARE",
          [draftId, conversationId],
        );
        if (draft.version !== expectedVersion)
          throw error(409, "草稿版本已变化", {
            draftId,
            version: draft.version,
          });
      }
      await db.query(
        `INSERT INTO mp_action(id,conversation,kind,payload,expected_version,quote_id,draft)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          actionId,
          conversationId,
          kind,
          JSON.stringify(payload),
          expectedVersion,
          quoteId,
          draftId,
        ],
      );
      const action = await one<Action>(db, actionSql, [userId, actionId]);
      const same = await db.query(
        `SELECT id FROM mp_action WHERE id=$1 AND conversation=$2 AND kind=$3 AND payload=$4::jsonb
        AND expected_version=$5 AND quote_id IS NOT DISTINCT FROM $6 AND draft IS NOT DISTINCT FROM $7`,
        [
          actionId,
          conversationId,
          kind,
          JSON.stringify(payload),
          expectedVersion,
          quoteId,
          draftId,
        ],
      );
      if (!same.rowCount) throw error(409, "操作标识已绑定到其他预览");
      return action;
    });
  }
  getAction(userId: string, actionId: string) {
    return one<Action>(this.pool, actionSql, [userId, actionId]);
  }
  async claimAction(
    userId: string,
    actionId: string,
    expectedVersion: number,
    quoteId: string | null,
  ) {
    return this.tx(async (db) => {
      const action = await one<Action>(db, actionSql + " FOR UPDATE OF a", [
        userId,
        actionId,
      ]);
      if (
        action.expectedVersion !== expectedVersion ||
        action.quoteId !== quoteId
      )
        throw error(409, "确认预览不匹配", {
          actionId,
          version: action.expectedVersion,
          quoteId: action.quoteId,
        });
      if (action.status !== "pending") return { claimed: false, action };
      if (action.draftId) {
        const draft = await one(
          db,
          "SELECT version FROM mp_draft WHERE id=$1 FOR SHARE",
          [action.draftId],
        );
        if (draft.version !== expectedVersion)
          throw error(409, "草稿版本已变化", {
            draftId: action.draftId,
            version: draft.version,
          });
      }
      await db.query("UPDATE mp_action SET status='submitting' WHERE id=$1", [
        actionId,
      ]);
      action.status = "submitting";
      return { claimed: true, action };
    });
  }
  async finishAction(
    userId: string,
    actionId: string,
    status: "succeeded" | "unknown" | "failed",
    result: object,
  ) {
    return this.tx(async (db) => {
      const action = await one<Action>(db, actionSql + " FOR UPDATE OF a", [
        userId,
        actionId,
      ]);
      if (action.status === "submitting") {
        await db.query("UPDATE mp_action SET status=$2,result=$3 WHERE id=$1", [
          actionId,
          status,
          JSON.stringify(result),
        ]);
        return one<Action>(db, actionSql, [userId, actionId]);
      }
      return action;
    });
  }
}
