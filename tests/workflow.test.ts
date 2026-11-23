import test from "node:test";
import assert from "node:assert/strict";
import { MemorySaver } from "@langchain/langgraph";
import { createApprovalFlow } from "../src/graphs/approval.ts";

test("确认节点挂起，恢复时只执行已绑定的操作", async () => {
  const calls: string[] = [];
  const flow = createApprovalFlow(new MemorySaver(), async (id) => {
    calls.push(id);
  });
  await flow.prepare("a");
  assert.deepEqual(calls, []);
  await flow.confirm("a");
  assert.deepEqual(calls, ["a"]);
});
