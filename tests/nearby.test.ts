import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/api.ts";
import { business } from "../src/graphs/business.ts";
import type { connectMcd } from "../src/integrations/mcd/index.ts";
import type { Store } from "../src/storage/store.ts";
import { MemorySaver } from "@langchain/langgraph";

test("门店查询校验两种请求，仅转发当前用户的凭据，返回公开门店字段", async (t) => {
  const queryCity = { beType: 1, searchType: 2, city: "上海", keyword: "南京路" };
  const queryGps = { beType: 5, searchType: 3, longitude: 121.49, latitude: 31.24 };
  const storeRow = { storeCode: "0007", storeName: "测试餐厅", address: "南京路", distance: 200, businessStatus: true };
  const accounts = [
    { id: "one", token: "token-one", apiKey: "api-one" },
    { id: "two", token: "token-two", apiKey: "api-two" },
  ];
  const calls: unknown[] = [];
  let closed = 0;
  let result: unknown = [{ ...storeRow, longitude: 121.49, extra: "私有字段" }];
  const connect = async (token: string) => ({
    close: async () => { closed++; },
    call: async (name: string, args: unknown) => {
      calls.push([token, name, args]);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const store = {} as Store;
  const app = createApi(store, business({ store, saver: new MemorySaver(), connect: connect as unknown as typeof connectMcd }), accounts);
  t.after(() => app.close());
  const post = (payload: object, key?: string) => app.inject({ method: "POST", url: "/stores/nearby", payload,
    headers: key ? { authorization: "Bearer " + key } : {} });
  assert.equal((await post(queryCity)).statusCode, 401);
  for (const payload of [
    {...queryCity, beType: 2}, {...queryCity, city: " "}, {...queryCity, keyword: ""},
    {...queryCity, latitude: 0}, {...queryGps, longitude: 181}, {...queryGps, latitude: -91},
    {...queryGps, latitude: "31"}, {...queryGps, keyword: "x"}, {...queryGps, searchType: 0},
  ]) assert.equal((await post(payload, "api-one")).statusCode, 400);
  assert.deepEqual(calls, []);
  for (const [i, input] of [queryCity, queryGps].entries()) {
    const response = await post(input, accounts[i].apiKey);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), [storeRow]);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(calls[i], [accounts[i].token, "query-nearby-stores", input]);
  }
  result = [];
  assert.deepEqual((await post(queryCity,"api-one")).json(), []);
  for (const failure of [{ stores: [] }, new Error("敏感供应商故障")]) {
    result = failure;
    const response = await post(queryGps, "api-two");
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error, "暂时无法查询门店，请稍后再试。");
  }
  assert.equal(closed, 5);
});
