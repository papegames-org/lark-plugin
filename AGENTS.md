# AGENTS.md

这个文件面向后续维护本仓库的 agent / 开发者，帮助快速理解插件边界、关键代码和修改注意事项。

## 仓库定位

`openclaw-skill-runtime` 是一个 OpenClaw hook 插件，不是独立服务，也不是业务应用。

它的职责非常聚焦：

- 监听明确技能调用、技能前置读取与技能运行时 hook 上下文
- 识别本次调用关联的 skill 是否对应某个 `SKILL.md`
- 解析该 skill 声明的 `larkAuth`
- 检查当前飞书应用是否已拥有所需 scope
- 对 `identity: user` 继续检查当前用户是否已授予所需 user scope
- 若任一层权限缺失，则发飞书授权卡片
- 按配置决定是否阻止本次技能继续执行

不要把这个仓库往“通用权限中心”方向扩；它现在的价值恰恰在于切口小、行为清晰。

## 为什么需要这个插件

企业在飞书上落地 AI Agent 时，每个 Skill（技能）都可能调用飞书开放平台 API，由此带来三个高频痛点：

1. **权限授权** — 企业内部 Skill 可能需要调用飞书开放平台 API、Lark CLI、AI 网关等多种第三方系统。每个系统各有鉴权方式，如果没有统一机制，要么权限过放开带来安全风险，要么权限不足导致技能中途失败，用户体验割裂。
2. **飞书卡片按钮交互** — 授权动作、确认操作都需要通过飞书卡片按钮来完成。如果每个 Skill 各自实现一套卡片交互逻辑，重复造轮子且难以维护。
3. **精准执行 Skill** — 传统模式下，“何时调用哪个 Skill”完全依赖大模型的判断，模型一旦选错就会导致流程中断或调用错误的能力，企业难以把控执行确定性和业务可靠性。

本插件一次性解决这三个问题，让企业可以专注在 Skill 业务本身，而不用关心权限、交互和执行调度的底层细节。

后续开发请优先围绕这三个目标展开。新增能力、扩展边界或重构实现时，先判断它是否直接增强了：

- 权限授权的统一性与安全性
- 飞书卡片交互的复用性与可维护性
- Skill 执行的确定性与业务可靠性

如果改动与这三点关系较弱，就先谨慎评估，避免把仓库扩成过宽的通用平台。

## 关键文件

- [index.js](./index.js)
  入口文件。注册 `before_prompt_build`、`message_received`、`before_agent_run`、`before_tool_call` 四类 hook。

- [parse-meta.js](./parse-meta.js)
  从 `SKILL.md` frontmatter 中解析 `larkAuth`。当前是零依赖实现，兼容 JSON 内联和 YAML 缩进两种格式。

- [utils.js](./utils.js)
  放置所有辅助逻辑：日志、workspace 缓存、account 缓存、skill 扫描、飞书开放平台调用、卡片发送、授权轮询。

- [pending-auth.js](./pending-auth.js)
  管理授权提醒失败后的 notice 状态、退避重试和本地持久化恢复。

- [openclaw.plugin.json](./openclaw.plugin.json)
  插件元信息和配置 schema。

## 理解主流程的最短路径

1. 看 [index.js](./index.js) 里的 `before_agent_run` / `before_tool_call`
2. 看 [parse-meta.js](./parse-meta.js) 里的 `readLarkAuthFromContent`
3. 看 [utils.js](./utils.js) 里的 `checkScopes` / `checkUserAuthorization`
4. 看 [utils.js](./utils.js) 里的 `sendAuthCard`
5. 看 [utils.js](./utils.js) 里的 `startWaitForAuth`

## 运行时前提

修改前先记住，这个插件依赖运行时提供：

- OpenClaw 的 hook API
- 飞书 channel 上下文
- `api.config.channels.feishu.accounts`

很多“看起来像普通 Node.js 代码”的函数，实际上都默认自己运行在上述环境里。脱离这些前提，代码很容易误判为“有 bug”。

## 修改时需要留意的点

### 1. `blockRead` 默认值现在已经统一为 `true`

[openclaw.plugin.json](./openclaw.plugin.json) 和 [index.js](./index.js) 现在都采用：

```js
const blockRead = cfg.blockRead !== false;
```

也就是默认 `true`。后续如果想改默认行为，记得 schema、README、阻断提示文案一起改。

### 2. 这套逻辑故意偏保守

[utils.js](./utils.js) 中，如果 `getAppScopes` 失败，会把目标 scopes 全部视为缺失。

这不是偶然行为，而是“宁可误拦，也不误放”的策略。动这块之前要先确认产品预期。

### 3. skill 识别仍然以绝对路径索引为主

插件先扫描 skill 根目录，同时维护路径到名称和名称到路径的解析能力。明确 skill command 会在 `before_agent_run` 中根据 OpenClaw 的标准调用提示反查 `SKILL.md`；模型自动选择 skill 时，`before_tool_call` 优先把 `read` 的 path 解析成绝对路径再匹配，并可从 `skillName` / `skillCommand` / `skillsSnapshot` 回退解析。

不要用自然语言模糊匹配猜测 skill。明确命令走模型前门禁，自动选择走 `SKILL.md` 读取兜底，这两类信号都必须保持可验证、可审计。

如果你改路径解析、workspace 推断或扫描深度，记得把这三部分一起看：

- [utils.js](./utils.js)
- [utils.js](./utils.js)
- [utils.js](./utils.js)

### 4. 同一个 skill 的授权轮询需要去重

[utils.js](./utils.js) 维护了一个 `activePollingIntervals`，避免重复启动多个轮询器。

如果你改授权完成逻辑或发卡节流逻辑，要一起检查：

- [index.js](./index.js)
- [utils.js](./utils.js)

### 5. `pendingAuthNotices` 现在是正式的失败重试队列

[index.js](./index.js) 中的 `pendingAuthNotices` 不再是单纯预留变量，而是：

- 以 `authTargetKey` 为 key 的内存状态表
- 与 [pending-auth.js](./pending-auth.js) 的 JSON 持久化文件联动
- 用来承接“缺权限已确认，但授权卡片发送失败”的自动重试流程

当前持久化路径优先走 OpenClaw 数据目录，而不是系统临时目录。

真正还偏“预留”的主要是：

- `lookupWorkspaceByAgentId`
- `appId` 参数

这两个删之前仍然要先确认外部没有隐含依赖。

### 6. 运行时健康检查已经完全收敛到飞书配置与 HTTP 调用

当前版本不再依赖仓库内的 CLI 包装层。

如果后续要继续增强“安装即用”和“重启后可恢复”的体验，优先扩展：

- [utils.js](./utils.js) 里的运行时健康检查
- [feishu-runtime.js](./feishu-runtime.js) 里的开放平台调用与授权链接生成

## 建议的修改原则

- 保持零外部依赖，除非确实解决了当前解析器做不到的问题
- 优先保持“授权前不放行”的安全倾向
- 不要把 UI 卡片构造和权限判断揉得更紧，尽量继续分层
- 发卡失败后的重试逻辑尽量继续收敛在 `pending-auth.js` 这一层，不要散回多个 hook
- `exhausted` 只是“自动重试耗尽”，不是永久冻结；用户再次触发 skill 读取时应允许显式重试
- 涉及运行时上下文时，优先读日志和缓存逻辑，不要只看单个 hook

## 发布与版本

这是一个发布到 npm 的公共工具，后续维护时把“版本一致”和“公开仓库安全”当成默认要求。

更完整的发布步骤、检查项和 npm 发布说明见 [docs/developer-release.md](./docs/developer-release.md)。

- 以下文件版本号应保持一致：
  - `package.json`
  - `package-lock.json`
  - `openclaw.plugin.json`
- 发布前优先跑 `npm run release:check`
- `release:check` 现在会串行执行：
  - `npm run check:version`
  - `npm run test`
  - `npm run check:public`
  - `npm run pack:dry`
- `check:public` 主要拦截：
  - 常见 token / private key
  - 明显像真实 secret 的内联赋值
  - `.npmrc` / `.env` / `.pem` / `.key` 这类高风险文件
  - 机器绝对路径、真实邮箱等 PII

如果后续改发布脚本、增删打包文件或引入新的演示目录，记得把这几层检查一起更新。

## 外部参考

- 卡片参考链接：[baileyh8/hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)
- 飞书卡片 JSON 结构参考：[Feishu Cards Card JSON V2 Structure](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
- 插件结构思想参考：[larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)

## 如果要继续扩展

优先考虑这些低风险方向：

- 给 README 补一段最小接入示例
- 给 `parse-meta.js` 加测试样例
- 给 `blockRead` 默认值做一次文档与实现统一
- 给卡片发送失败路径补更明确的日志或兜底提示

不建议直接上来做这些高风险改动：

- 把 scope 校验改成更宽松的放行策略
- 改成在 skill 真正执行后才做授权
- 把这个插件改造成处理所有文件读取的通用拦截器
