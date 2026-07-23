---
name: papergames-feishu-approve
description: Use when the user asks in Chinese or English to query, view, summarize, approve, reject, or operate Feishu/Lark approvals. Trigger on words like 审批、待审批、待办审批、审批数据、审批列表、流程名称、流程名、申请人、发起人、申请时间、发起时间、提交时间、到达时间、字段、金额、预算、供应商、合同编号、满足条件, including requests such as 查询某流程的待审批数据、查流程名称是X且申请时间在某日期之前/之后的待审批、查看字段A满足条件的审批、预算大于X的审批、同意/驳回审批, approval scope authorization, and Feishu approval card callbacks.
---

# Papergames Feishu Approve

查询和处理当前登录用户的待审批。这个 skill 现在只保留 Python 薄壳、鉴权和 OpenClaw bridge；审批查询、分页、实例富化、summary context、卡片渲染、拆卡、快照、按钮回调、文本审批动作都由 `vendor/workkit` CLI 实现。

## Core Rules

1. 查询入口固定用 `python3 scripts/query_approvals.py`。
2. 用户查询待审批/审批列表/审批数据时，默认必须发送 workkit 渲染的 Feishu 交互卡片：使用 `--output feishu_card`（默认值），不要改用 `json` 来生成最终回复。
3. 不要把查询结果改写成 Markdown 表格、纯文本清单或“查询结果”普通消息；脚本成功时只允许播报 `已发送审批卡片`，详细数据必须在卡片里。
4. AI 文本回复只允许使用固定流程状态，不要解释内部步骤。允许的状态文本只有：`授权申请中`、`意图分析中`、`意图分析完成`、`审批数据准备中`、`结果生成中`、`已发送审批卡片`、`需要补充授权`、`未找到符合条件的审批`。
5. 对外不要说“拉审批列表 / 拉详情 / 抽字段 / 字段画像 / 字段置信 / schema / confidence / requestId”等内部实现；这些统一归为 `审批数据准备中`。
6. 在 OpenClaw/飞书聊天运行时，优先让脚本从 `OPENCLAW_CHAT_ID` / `OPENCLAW_INBOUND_CHAT_ID` / `OPENCLAW_SENDER_ID` 自动解析接收目标；用户显式给 chat_id 时才传 `--send-chat-id`。
7. 缺少审批 scope 时只能通过 `scripts/send_auth_and_wait.py` 发授权卡片，不要直接裸跑 `lark-cli auth login`。
8. OA 详情授权默认必需：查询默认启用 OA 详情补充；若 workkit 返回 `OA_AUTH_REQUIRED`，Python bridge 必须调用 `scripts/oa_send_auth_and_wait.py` 发送 OA 授权卡并在授权成功后重试同一查询。只有用户显式要求禁用 OA 详情或设置 `PAPER_FEISHU_APPROVE_FETCH_OA_DETAILS=0` 时才允许降级。
9. 审批查询和审批动作使用用户身份；授权卡、结果卡和状态提示使用 app/bot 身份发送。
10. 文本审批动作走 `python3 scripts/text_approval_action.py ...`，内部调用 `workkit approval action text ...`。
11. 卡片按钮回调走 OpenClaw 插件 `extensions/papergames-approval-handler/`；通过/驳回默认先返回“处理中”toast，再后台调用 `scripts/card_action_handler.py` 执行 `workkit approval action handle-card-event ...` 并刷新卡片。若需排障回退同步模式，可设置 `PAPER_FEISHU_APPROVE_ASYNC_ACTIONS=0`。
12. 普通输出禁止明文暴露 `task_id`、`instance_code`、`process_id`、`message_id`、`open_message_id`、直接详情 URL。
13. 安装/补依赖完成后，如需播报，必须原样输出 `scripts/common.py:POST_INSTALL_HINT_MESSAGE` 常量内容。
14. 复合筛选必须保留全部条件；不要只提取第一个命中的字段。遇到“且/并且/与/和/或/或者”等多条件查询时，优先把用户原句完整传给 `--description` 让 workkit 统一解析；如果拆成结构化参数，也必须同时带齐每个已识别参数，例如 `--process` 与 `--started-before`。
15. 审批结果卡片默认 30 分钟有效，有效期只作为隐藏回调元数据和 snapshot 判断，不要在卡片正文展示；可用 `WORKKIT_APPROVAL_CARD_TTL_SECONDS` 或 `PAPER_FEISHU_APPROVE_CARD_TTL_SECONDS` 调整。用户点击过期卡片或较早查询卡片时，按钮回调必须提示“这是较早的查询卡片，已失效。请使用最新卡片进行操作。”
16. 卡片按钮回调需要区分处理结果：成功显示已通过/已驳回，有必填字段显示“含必填项，点发起人处理”，审批已被他人处理或不再待办时显示“已被处理”并隐藏按钮，不要归为普通处理失败。

## User-Facing Flow

对查询类请求，内部可以执行授权检查、意图分析、列表查询、详情补充、动态字段抽取、字段置信检索和过滤，但对用户只展示下面这些流程名称：

1. `授权申请中`
2. `意图分析中`
3. `审批数据准备中`
4. `结果生成中`

正常结果必须落成 Feishu 交互卡片；不要用文本、Markdown 表格或普通消息承载审批明细。如果字段筛选存在歧义，优先用澄清卡片；临时不支持澄清卡时，只能短问一句，不输出候选打分。

## Main Entrypoints

### 查询审批

```bash
python3 scripts/query_approvals.py --description "请假" --send-chat-id "<chat_id>"
python3 scripts/query_approvals.py --applicant "张三"
python3 scripts/query_approvals.py --process "用印"
python3 scripts/query_approvals.py --applicant "张三" --process "请假"
python3 scripts/query_approvals.py --process "系统需求申请单" --started-before "2026-04-01"
python3 scripts/query_approvals.py --description "流程名称是【用印申请】，且申请时间在2026年7月之前发起的待审批数据"
python3 scripts/query_approvals.py --description "流程名称是【用印申请】，且“用印类型”为“发票章”的待审批数据"
```

面向用户的查询必须走默认 `feishu_card` 发卡路径，例如：

```bash
python3 scripts/query_approvals.py --process "请假-测试流程审批" --started-before "2026-07-16"
```

常见中文查询映射：

- “流程名称是 X / X 流程” → `--process "X"`
- “申请时间/发起时间/提交时间在 2026 年 4 月之前” → `--started-before "2026-04-01"`
- “申请时间/发起时间/提交时间在 2026 年 4 月之后” → `--started-after "2026-04-01"`
- “申请时间/发起时间/提交时间是 2026-04-01” → `--started-on "2026-04-01"`
- 多条件查询，如“流程名称是 X，且申请时间在 Y 之前” → 保留整句到 `--description`，或显式同时传 `--process "X" --started-before "Y"`。
- 动态字段查询，如“流程名称是 X，且字段 A 为 B” → 保留字段名和值，优先整句到 `--description`；不要降级成 `--process "X" --description "B"`。

真实发卡默认使用 table-summary 卡片。默认会由 workkit 自动生成 AI summary overrides（需环境里有 `ARK_BASE_URL` / `ARK_API_KEY` / `ARK_MODEL_ID`，或 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`）。

### 补授权 / 检查授权

```bash
python3 scripts/send_auth_and_wait.py --auth-mode read --chat-id "<chat_id>"
python3 scripts/send_auth_and_wait.py --auth-mode write --chat-id "<chat_id>"
```

scope 策略只看 `scripts/approval_auth.py:required_scopes_for_mode()`。读写模式都会补齐 `approval:task:read`、`approval:task:write`、`approval:instance:read`。

### 文本审批

```bash
python3 scripts/text_approval_action.py "通过全部请假申请"
python3 scripts/text_approval_action.py "拒绝访客申请" --chat-id "<chat_id>"
```

### 卡片回调

```bash
python3 scripts/card_action_handler.py --event-json '<card.action.trigger event>'
```

### OpenClaw 安装

```bash
bash install-openclaw.sh
openclaw gateway restart
```

## Files

| 文件                                      | 职责                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `scripts/query_approvals.py`              | 主入口：鉴权预检 → 必要时补授权 → 调 `workkit_query.py`。                         |
| `scripts/workkit_query.py`                | workkit 查询/渲染/发送/快照桥接薄壳。                                             |
| `scripts/send_auth_and_wait.py`           | 显式审批 scope 授权卡片。                                                         |
| `scripts/paper_api_auth.py`               | Paper API token 获取。                                                            |
| `scripts/oa_send_auth_and_wait.py`        | OA/Paper API 授权卡片兜底流程。                                                   |
| `scripts/approval_auth.py`                | `core.auth` 兼容入口，负责 lark-cli profile、scope 检查、OAuth 登录流程。         |
| `scripts/card_action_handler.py`          | OpenClaw 卡片回调薄壳，调 workkit action。                                        |
| `scripts/_bg_update_card.py`              | 回调后异步用 workkit snapshot/card-kit 刷新卡片。                                 |
| `scripts/text_approval_action.py`         | 自然语言审批薄壳，调 workkit text action。                                        |
| `scripts/common.py` / `scripts/core/`     | 鉴权、日志、脱敏、Feishu 发消息/刷卡运行时。                                      |
| `extensions/papergames-approval-handler/` | OpenClaw interactive bridge。                                                     |
| `vendor/workkit/`                         | 审批业务实现、Feishu adapter、card-kit、snapshot/action runtime 和 CLI 构建产物。 |

## Troubleshooting

| 症状                                     | 解法                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `authorization_required` 反复出现        | 走 `scripts/send_auth_and_wait.py` 重新补授权。                                                      |
| `lark-cli is not bound to it`            | 先执行 `lark-cli config bind --source openclaw --identity user-default`。                            |
| 文本审批 `missing_snapshot` / `no_match` | 重新查询一次审批卡片，或把描述说具体。                                                               |
| 卡片按钮无响应                           | 确认 `papergames-approval-handler` 已安装并重启 gateway；日志看 `/tmp/approval-handler-events.log`。 |
| 卡片按钮提示需要进详情                   | 该审批有必填字段或不支持快捷拒绝；进入飞书审批详情页处理。                                           |
