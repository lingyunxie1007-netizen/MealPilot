# MealPilot 技术方案

版本 0.1 · 2026-11-22 · 设计稿

## 1. 交付目标

面向麦当劳中国用户，支持早餐、午餐、下午茶、晚餐和夜宵。用户从常规餐品营养咨询进入指定时段和门店的推荐，可以比较多份草稿、核对实付、确认下单，也可直接进入优惠、积分、商城、活动或订单查询。餐段是展示标签，实际供应以目标时间、门店、履约方式对应的查询结果为准。

## 2. 服务边界

建议采用 Node.js、TypeScript、Fastify、PostgreSQL，首版部署一个应用服务。浏览器通过 HTTP 提交消息，通过 SSE 订阅文本增量、候选卡片、确认请求和业务状态。Pi Agent Core、LangGraph JS 和 MCP 客户端同进程运行，减少跨服务状态同步。首版由单个实例持有活跃的 Pi 会话，重启时从持久化消息与业务草稿重建上下文。

| 模块 | 对应代码位置（建议） | 职责 |
|---|---|---|
| 会话入口 | src/api | 鉴权、消息去重、SSE、确认请求 |
| Agent 运行时 | src/agent | 使用 @earendil-works/pi-agent-core 注册 AgentTool，读取结构化结果，流式解释、接收 steer() |
| 工作流 | src/graphs | 使用 @langchain/langgraph 实现推荐、订单、会员及活动流程，按工作流实例保存 checkpoint |
| 推荐计算 | src/domain/meals | 餐品规格映射、营养合计、硬条件过滤、候选排序和差异计算 |
| MCP 适配 | src/integrations/mcd | 使用 MCP TypeScript 客户端，发现工具、参数校验、解析 TOON 和 JSON、错误分类 |
| 存储 | src/storage | 会话消息、草稿版本、报价、交易操作与用户凭据引用 |

Pi 自主决定尝试哪种替换，通过 find_meal_options、revise_meal、compare_drafts、prepare_action 等领域工具发起工作流。工具参数使用 schema 校验，每次探索设最大轮数和候选数。查询无解时返回可验证的差额或缺失信息。写操作的执行入口由应用确认接口持有。权威业务状态可从数据库恢复，模型上下文只携带当前偏好、草稿引用和查询摘要。

## 3. 推荐与报价工作流

1. 解析用户给出的硬约束与排序偏好，分别保存。例如「最多 25 元」是硬约束，「便宜一点」是排序偏好。以 Asia/Shanghai 解析相对时间，跨午夜时保存完整日期。
2. 通用营养模式直接读取标准餐品。门店模式先解析履约方式与门店，外送通过用户选择的地址查询。将预约时间贯穿菜单、详情、适用券和算价。
3. 取得可售菜单、营养表和必要的套餐详情。解析 TOON 表头，区分 energyKcal 与 energyKj。用已验证的商品编码、规格和份数映射营养行，记录数据来源和匹配状态。无法匹配的定制项保留未知值。
4. 按餐品类别和必选项生成候选，用代码按份数求和，过滤预算之外的明确硬约束。热量未知的候选不能标为热量达标。套餐按整套已知数据或组成件核算，避免双计。过敏原约束须有相应证据。
5. 对入围候选查询适用券与促销，用 calculate-price 取得实付并执行预算过滤，外送费用以同次报价为准。首版建议最多报价 5 套，输出差异明显的 2 至 3 套。排序说明限于已核验候选。若报价失败，显示价格待核实。
6. 结果写入对应草稿版本。修改目标门店、时间、履约方式、商品或用券方案后刷新相关结果。只问「为什么推荐」时复用该版本的明细。

## 4. 工具路由与权限

初始化 MCP 会话后以 tools/list 及分页结果建立该用户的可用能力集，对照下面的文档基线。运行时取注册表与实际能力的交集。企业团餐、外送、得来速分别使用官方定义的业务类型与入参。新增工具经过映射与契约测试后开放。

| 工作流 | 官方工具 |
|---|---|
| 时间、门店、履约 | now-time-info、query-nearby-stores、delivery-query-addresses、delivery-create-address、delivery-query-stores、query-meal-assistance |
| 餐品与算价 | list-nutrition-foods、query-meals、query-meal-detail、calculate-price |
| 优惠与领取 | query-my-coupons、query-store-coupons、query-promotions、available-coupons、auto-bind-coupons |
| 餐饮订单 | create-order、query-order、order-list、cancel-order |
| 会员与商城 | query-my-account、query-mall-products、mall-product-detail、mall-gift-products、mall-create-order、mall-order-list、mall-order-detail |
| 营销和预约 | campaign-calendar、query-party-city、query-party-store、query-partystore-date、query-partystore-session、party-order-create |
| 抽奖 | query-lottery-info、query-my-prizes、draw-lottery |

查询使用当前用户凭据。领券、保存地址、创建或取消订单、积分兑换、预约、抽奖都要求用户明确指定操作。对下单、扣积分等操作展示预览并绑定确认版本。auto-bind-coupons 的预览明确写出「领取全部当前可领券」。

## 5. 数据模型与一致性

| 记录 | 关键字段与约束 |
|---|---|
| conversation / message | user_id、conversation_id、client_message_id、role、content，与会话组合的 client_message_id 唯一 |
| meal_draft / draft_revision | draft_id、parent_draft_id、version、约束、时间、门店、履约方式、餐品和规格、营养依据。每次变更加版本，历史版本可查 |
| quote | quote_id、draft_id、version、issued_at、金额与币种、费用明细、优惠引用、供应商返回摘要。金额统一转换为整数分，缺失金额保留未知 |
| action | action_id、user_id、kind、业务对象与版本、quote_id、请求摘要、状态、provider_order_id。确认重试复用同一个 action_id |
| workflow checkpoint | 独立 workflow_run_id 映射到 LangGraph thread_id，关联 user_id、conversation_id 和 draft_id |

同一份草稿按期望版本做条件更新。Pi 在查询中接收到新诉求时，可通过 steer() 改变下一轮决策，已发出的请求仍可能返回。结果带上 draft_id 和 version，当前版本不匹配时只保留历史结果。「保留早餐，再看夜宵」显式分配新 draft_id。不同草稿可以分别暂停、恢复与确认。

应用表保存可展示和交易核验的业务事实。checkpoint 保存图的执行位置、输入版本和记录 ID。应用写入按稳定标识执行幂等更新，允许节点在 checkpoint 保存前发生崩溃后重跑。Token 按用户加密保存，checkpoint、模型输入、日志和跟踪数据仅保留凭据引用。订单、地址与支付链接按所属用户授权访问。

## 6. API 与提交协议

| 接口 | 契约 |
|---|---|
| POST /conversations | 创建会话并返回 conversationId |
| POST /conversations/:id/messages | 接收 clientMessageId、text、可选 draftId，返回 runId。相同消息重复提交返回同一处理结果 |
| GET /runs/:id/events | SSE 输出 text_delta、draft_ready、confirmation_required、run_completed、run_failed。每条事件包含 runId 与序号，草稿事件另带版本 |
| GET /drafts/:id | 返回用户有权读取的当前版本、候选及最近报价 |
| POST /actions/:id/confirm | 接收 expectedVersion 和报价引用，返回 pending、succeeded、failed 或 unknown；版本冲突返回 409 和最新预览引用 |
| GET /actions/:id | 返回已知执行状态；断线重连后可直接恢复结果卡片 |

准备节点生成不可变预览。确认节点通过 interrupt() 暂停。确认接口校验归属与版本，恢复指定图实例。执行前复核可售和报价，如发生实质变化则创建新预览并再次确认。执行节点在数据库事务中取得该 action 唯一的提交权，记录 submitting 后才调用对应的 MCP 写工具。并发确认只返回已有状态。

一旦远端调用可能已发出，超时或进程退出都按结果未知处理。通过供应商订单号或能够唯一关联的记录核对；无法唯一匹配时保留待核对。即使本地有唯一键，也不能据此保证供应商端的恰好一次执行。只读查询对临时故障有限重试，鉴权失败提示更新凭据。

## 7. 实施顺序与验收

| 阶段 | 验收门槛 |
|---|---|
| 接口验证 | 用真实 Token 发现工具。记录脱敏的预约早餐、即时菜单、夜间外送、营养、报价样例，验证字段、单位、菜单与营养规格匹配率并报告分母 |
| 全时段推荐 | 五个时段各有可复现用例。可售与不可售均能解释。换配餐后逐项营养合计正确，预算包含实际费用，缺数据不宣称达标 |
| 多草稿与交易 | 查询中途改条件、早餐与夜宵切换、重复确认、报价变化、进程重启和提交超时均有覆盖。校验每次写调用的用户、草稿版本与执行次数 |
| 会员能力 | 35 项工具均有路由、样例与权限分支，覆盖查券与领券、餐饮与商城订单、预约满场、积分不足。写操作先用模拟服务验收 |

记录工具成功率、每轮模型调用次数、报价耗时、可售菜单营养匹配率、未知交易数。首轮联调据实确定缓存期限、超时和性能目标。菜单及个人报价按用户、门店、时间、履约方式和规格隔离。官方营养表与个人券、价格分别设置缓存策略。

## 8. 依据与待验证项

本设计采用公开文档，尚未进行真实账户联调。正式接入前需验证该账户的工具权限、预约时段供应、价格响应单位、商品规格关联，以及各写接口能否提供可靠的业务关联键。

- [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent)
- [LangGraph JS Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 和 [中断恢复语义](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [麦当劳 MCP 开放平台](https://open.mcd.cn/mcp)、[工具文档](https://open.mcd.cn/mcp/doc) 和 [营养计算器](https://www.mcdonalds.com.cn/nutrition_calculator)
