import { z } from "zod";
import { mealRequest } from "../domain/meals/index.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type Execute = (name: string, args: any) => Promise<any>;
const text = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0 };
const args = { type: "object", additionalProperties: true };
const targets = {
  name: text,
  arguments: args,
  draftId: text,
  version: integer,
  quoteId: text,
};
// 复用领域模型的输入 schema，使推荐和修订同时支持新的硬约束。
const meal = z.toJSONSchema(mealRequest, { io: "input" }).properties ?? {};

// 每个工具只提交领域请求；写操作的确认和执行由应用持有。
export function domainTools(execute: Execute): AgentTool[] {
  function tool(
    name: string,
    description: string,
    properties: object,
    required: string[],
  ): AgentTool {
    return {
      name,
      label: name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      async execute(_callId, params) {
        const details = await execute(name, params);
        return {
          content: [{ type: "text", text: JSON.stringify(details) ?? "null" }],
          details,
        };
      },
    };
  }
  return [
    tool(
      "find_meal_options",
      "新建草稿，按实际可售餐品、硬约束和偏好推荐。预算单位为分。",
      meal,
      [],
    ),
    tool(
      "revise_meal",
      "按已知版本修改现有草稿，只传变更的约束。",
      { ...meal, draftId: text, expectedVersion: integer },
      ["draftId", "expectedVersion"],
    ),
    tool(
      "compare_drafts",
      "读取并比较当前会话中指定的草稿。",
      { draftIds: { type: "array", items: text, minItems: 1, maxItems: 5 } },
      ["draftIds"],
    ),
    tool(
      "query_service",
      "传 name=list_tools 和空 arguments 获取用户可用工具及入参，再按官方 schema 调用只读工具。相对日期用 now-time-info 核实。",
      { name: text, arguments: args },
      ["name", "arguments"],
    ),
    tool(
      "prepare_action",
      "创建待用户确认的操作预览；传官方写工具名、参数和相关草稿引用。",
      targets,
      ["name", "arguments"],
    ),
  ];
}
