# MealPilot

麦当劳中国全时段用餐与会员助手的 TypeScript 后端。Pi Agent Core 负责对话与工具循环，LangGraph 负责推荐和交易确认，PostgreSQL 保存草稿、消息、事件和操作状态。项目的业务目标见 [技术方案](docs/technical-design.md)。

## 本地启动

安装 Node.js 24、pnpm 11 和 PostgreSQL。在已有数据库中为应用账号授予建表权限，服务首次启动会创建业务表及 LangGraph 检查点表。采用单实例部署，启动恢复逻辑会收尾上次进程遗留的运行记录。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

在 .env 中设置 DATABASE_URL、OPENAI_API_KEY，以及 MEALPILOT_ACCOUNTS 内每个用户的应用访问密钥和麦当劳 MCP Token。模型端点需要支持 OpenAI Chat Completions 流式输出和工具调用。服务器默认监听 127.0.0.1:3000。凭据由部署环境提供，.env 仅用于本地开发。

```powershell
pnpm start
```

## 在浏览器里测试

打开 [MealPilot 点餐助手](http://127.0.0.1:3000/)，点击右上角钥匙按钮。输入本地 .env 中 MEALPILOT_ACCOUNTS 对应用户的 apiKey，点击「连接服务」。访问密钥保存在当前浏览器标签页的 sessionStorage；模型密钥与麦当劳 Token 由服务端管理。

选择早餐、午餐、下午茶、晚餐或夜宵可以填入示例需求，也可以直接输入消息。Enter 发送，Shift+Enter 换行。结果会随查询流式显示。搭配卡支持查看营养与规格依据、选中草稿继续提问，操作预览支持人工确认。刷新页面会清空当前显示的对话，服务端已有记录依然保留。页面与 API 由同一个 Fastify 服务提供，无需安装前端依赖。

## 发起第一轮对话

下面的 PowerShell 示例使用用户自己的应用密钥。API 路径中的会话、运行、草稿及操作编号均来自上一条响应。

```powershell
$headers = @{Authorization = "Bearer $env:MEALPILOT_API_KEY"}
$url = "http://127.0.0.1:3000"
$chat = Invoke-RestMethod -Method Post -Uri "$url/conversations" -Headers $headers
$message = @{clientMessageId = [guid]::NewGuid().ToString(); text = "明早八点想吃麦当劳，想保留咖啡，预算25元"} | ConvertTo-Json
$run = Invoke-RestMethod -Method Post -Uri "$url/conversations/$($chat.conversationId)/messages" -Headers $headers -Body $message -ContentType "application/json; charset=utf-8"
curl.exe -N -H "Authorization: $($headers.Authorization)" "$url/runs/$($run.runId)/events"
```

复用 clientMessageId 可重取相同请求的 runId。SSE 支持 Last-Event-ID 断点续读。draft_ready 包含草稿编号与版本，confirmation_required 包含 actionId、expectedVersion、quoteId 和预览。客户端应展示预览并在用户明确确认后调用 POST /actions/:id/confirm，正文传入原预览的 expectedVersion 与 quoteId。可通过 GET /actions/:id 查询结果。交易状态 unknown 表示远端结果待核对，可查询对应订单或权益记录。

## 代码入口

| 文件 | 内容 |
|---|---|
| src/agent/index.ts、src/agent/tools.ts | Pi Core 的 Agent、prompt、steer、流式订阅与领域工具 |
| src/graphs/business.ts、src/graphs/approval.ts | 推荐图、草稿写入、预览、interrupt 和恢复执行 |
| src/integrations/mcd/index.ts | 35 项工具注册表、MCP 能力发现、参数校验和官方返回值解析 |
| src/domain/meals | 搭配候选、规格映射、营养合计及门店实付校验 |
| src/storage | PostgreSQL schema、草稿版本、事务和事件顺序 |
| src/api.ts、src/server.ts | HTTP 鉴权、SSE、会话生命周期与服务启动 |

门店商品和营养行可通过经核实的编码匹配，也可设置 MCD_NUTRITION_MAPPING 指向 UTF-8 JSON 数组。每条记录提供 productCode、menuName、nutritionName、nutritionDescription 和 evidence。编码、餐品名称、规格描述与证据应来自同一实际规格。没有可靠匹配时会显示缺失状态，硬热量约束会排除该候选。

## 验证

```powershell
pnpm check
pnpm test
```

设置 TEST_DATABASE_URL 指向专用测试数据库即可执行包含 PostgreSQL 的完整测试。未设置时数据库测试会跳过。测试使用本地模型响应与模拟供应商，覆盖五个时段、真实 Pi 工具循环、草稿并发、HTTP 事件、报价变化和重复确认。对接真实服务时先用用户 Token 核验工具列表、指定门店可售菜单和报价，再测试用户需要的操作。
