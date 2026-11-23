import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Store } from "./storage/store.ts";
import { business } from "./graphs/business.ts";
import { accountsSchema, createApi } from "./api.ts";

const accounts = accountsSchema.parse(
  JSON.parse(process.env.MEALPILOT_ACCOUNTS ?? "[]"),
);
if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY)
  throw new Error("需要 DATABASE_URL 和 OPENAI_API_KEY");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const saver = new PostgresSaver(pool);
const store = new Store(pool);
await store.init();
await saver.setup();
await store.recoverInterrupted();
const app = createApi(store, business({ store, saver }), accounts);
app.addHook("onClose", () => pool.end());
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close());
