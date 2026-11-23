import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMealAgent } from "../src/agent/index.ts";

test("Pi 恢复对话历史，在工具执行期间接收新指引，并流式返回最终答复", async (t) => {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const first = requests.length === 1;
    const chunks = first
      ? [
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: {
                  name: "compare_drafts",
                  arguments: JSON.stringify({ draftIds: ["早餐草稿"] }),
                },
              },
            ],
          },
        ]
      : [{ role: "assistant", content: "已改为" }, { content: "早餐" }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    function send(delta: object, finish_reason: string | null = null) {
      const data = {
        id: "mock",
        object: "chat.completion.chunk",
        model: "mock",
        choices: [{ index: 0, delta, finish_reason }],
      };
      res.write("data: " + JSON.stringify(data) + "\n\n");
    }
    for (const chunk of chunks) send(chunk);
    send({}, first ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const previous = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:" + port + "/v1";
  process.env.OPENAI_API_KEY = "local-test";
  const calls: unknown[] = [];
  const events: string[] = [];
  const agent = createMealAgent({
    history: [
      { role: "user", content: "保留早餐" },
      { role: "assistant", content: "已保存草稿" },
    ],
    execute: async (name, args) => {
      calls.push({ name, args });
      agent.steer("请改为早餐");
      return { draftId: "早餐草稿", version: 3 };
    },
    emit: (event, { delta }) => {
      if (event === "text_delta") events.push(delta);
    },
  });

  assert.throws(() => agent.steer("未开始"));
  assert.equal(await agent.prompt("先看午餐"), "已改为早餐");
  assert.deepEqual(events, ["已改为", "早餐"]);
  assert.deepEqual(calls, [
    { name: "compare_drafts", args: { draftIds: ["早餐草稿"] } },
  ]);
  assert.equal(requests.length, 2);
  const initial = requests[0].messages.slice(-3);
  assert.deepEqual(
    initial.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  for (const [index, expected] of [
    "保留早餐",
    "已保存草稿",
    "先看午餐",
  ].entries()) {
    assert.ok(JSON.stringify(initial[index].content).includes(expected));
  }
  assert.ok(
    requests[1].messages.some(
      (message) =>
        message.role === "tool" &&
        JSON.stringify(message.content).includes("早餐草稿"),
    ),
  );
  assert.ok(
    requests[1].messages.some(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("请改为早餐"),
    ),
  );
  assert.throws(() => agent.steer("运行已结束"));
});
