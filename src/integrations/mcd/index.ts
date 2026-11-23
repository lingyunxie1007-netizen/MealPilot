import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const writes = new Set([
  "delivery-create-address",
  "auto-bind-coupons",
  "create-order",
  "cancel-order",
  "mall-create-order",
  "party-order-create",
  "draw-lottery",
]);
export const isWriteTool = (name: string) => writes.has(name);
export const TOOL_NAMES = [
  ...writes,
  "now-time-info",
  "query-nearby-stores",
  "delivery-query-addresses",
  "delivery-query-stores",
  "query-meal-assistance",
  "list-nutrition-foods",
  "query-meals",
  "query-meal-detail",
  "calculate-price",
  "query-my-coupons",
  "query-store-coupons",
  "query-promotions",
  "available-coupons",
  "query-order",
  "order-list",
  "query-my-account",
  "query-mall-products",
  "mall-product-detail",
  "mall-gift-products",
  "mall-order-list",
  "mall-order-detail",
  "campaign-calendar",
  "query-party-city",
  "query-party-store",
  "query-partystore-date",
  "query-partystore-session",
  "query-lottery-info",
  "query-my-prizes",
];

// 官方营养表使用逗号分隔的 TOON 表格，按表头解析，绝不按列序猜单位。
export function parseNutritionTable(text: string) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const match = /^\[(\d+)\]\{([^}]+)\}:$/.exec(header.trim());
  if (!match || Number(match[1]) !== lines.length)
    throw new Error("营养表行数或表头异常");
  const keys = match[2].split(",").map((k) => k.trim());
  return lines.map((line) => {
    const cells: unknown[] = [];
    const pattern = /\s*("(?:[^"\\]|\\.)*"|[^",]*?)\s*(,|$)/gy;
    let end = 0;
    while (true) {
      const m = pattern.exec(line);
      if (!m) throw new Error("营养表单元格异常");
      const value = m[1];
      cells.push(
        value.startsWith('"')
          ? JSON.parse(value)
          : value === "null"
            ? null
            : /^-?\d+(\.\d+)?$/.test(value) &&
                !/code|id/i.test(keys[cells.length] ?? "")
              ? Number(value)
              : value,
      );
      end = pattern.lastIndex;
      if (!m[2]) break;
    }
    if (cells.length !== keys.length || end !== line.length)
      throw new Error("营养表列数异常");
    return Object.fromEntries(keys.map((k, i) => [k, cells[i]]));
  });
}

export function unpack(value: any): any {
  if (value?.isError) throw new Error("供应商工具执行失败");
  if (value?.structuredContent !== undefined)
    return unpack(value.structuredContent);
  if (Array.isArray(value?.content)) {
    const parts = value.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => unpack(p.text));
    return parts.length === 1 ? parts[0] : parts;
  }
  if (typeof value === "string") {
    if (/^\s*\[\d+\]\{/.test(value)) return parseNutritionTable(value);
    // 普通文本和纯数字编码须原样保留；仅解析结构化 JSON。
    if (!/^\s*[\[{]/.test(value)) return value;
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    return unpack(parsed);
  }
  if (value?.success === false) throw new Error("麦当劳业务请求失败");
  return value?.success === true && "data" in value
    ? unpack(value.data)
    : value;
}

export async function connectMcd(token: string) {
  if (!token.trim()) throw new Error("需要麦当劳 MCP Token");
  const client = new Client({ name: "MealPilot", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://mcp.mcd.cn"),
    {
      requestInit: {
        headers: { Authorization: "Bearer " + token },
        redirect: "error",
      },
    },
  );
  const tools: Record<string, Tool> = Object.create(null);
  const validator = new AjvJsonSchemaValidator();
  try {
    await client.connect(transport);
    if (!client.getServerCapabilities()?.tools)
      throw new Error("服务未开放工具");
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools)
        if (TOOL_NAMES.includes(tool.name)) tools[tool.name] = tool;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("工具分页游标重复");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return {
      tools,
      close: () => client.close(),
      async call(name: string, args: Record<string, unknown> = {}) {
        if (!tools[name]) throw new Error("当前账户无此工具权限");
        const checked = validator.getValidator(tools[name].inputSchema)(args);
        if (!checked.valid)
          throw new Error(name + " 参数错误：" + checked.errorMessage);
        return unpack(await client.callTool({ name, arguments: args }));
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
