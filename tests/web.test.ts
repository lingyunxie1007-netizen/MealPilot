import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import type { Store } from "../src/storage/store.ts";

test("浏览器无需密钥即可取得页面、样式及模块，业务接口仍按用户鉴权", async (t) => {
  const apiKey = "local-web-regression-api-key";
  const store = { createConversation: async (userId: string) => userId } as Store;
  const app = createApi(store, {} as Parameters<typeof createApi>[1], [
    { id: "browser-user", apiKey, token: "test" },
  ]);
  t.after(() => app.close());
  for (const [url, file, mime] of [
    ["/", "index.html", "text/html"],
    ["/style.css", "style.css", "text/css"],
    ["/app.js", "app.js", "text/javascript"],
    ["/cards.js", "cards.js", "text/javascript"],
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers["content-type"], mime + "; charset=utf-8");
    assert.deepEqual(response.rawPayload, await readFile(new URL("../web/" + file, import.meta.url)));
  }
  for (const url of ["/package.json", "/style.css.extra", "/web/app.js", "/.env"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
  }
  assert.equal((await app.inject({ method: "POST", url: "/app.js" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/conversations" })).statusCode, 401);
  const authorized = await app.inject({
    method: "POST",
    url: "/conversations",
    headers: { authorization: "Bearer " + apiKey },
  });
  assert.deepEqual(authorized.json(), { conversationId: "browser-user" });
});
