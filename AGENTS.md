# AGENTS.md

这个文件面向后续维护本仓库的 agent / 开发者，帮助快速理解插件边界、关键代码和修改注意事项。

## 仓库定位

`lark-scope-preauth` 是一个 OpenClaw hook 插件，不是独立服务，也不是业务应用。

它的职责非常聚焦：

- 监听 `read` 工具调用
- 识别被读取的文件是否为某个 skill 的 `SKILL.md`
- 解析该 skill 声明的 `larkAuth`
- 检查当前飞书应用是否已拥有所需 scope
- 若缺 scope，则发飞书授权卡片
- 按配置决定是否阻止本次读取

不要把这个仓库往“通用权限中心”方向扩；它现在的价值恰恰在于切口小、行为清晰。

## 关键文件

- [index.js](./index.js)
  入口文件。注册 `before_prompt_build`、`message_received`、`before_tool_call` 三类 hook。

- [parse-meta.js](./parse-meta.js)
  从 `SKILL.md` frontmatter 中解析 `larkAuth`。当前是零依赖实现，兼容 JSON 内联和 YAML 缩进两种格式。

- [utils.js](./utils.js)
  放置所有辅助逻辑：日志、workspace 缓存、account 缓存、skill 扫描、飞书开放平台调用、卡片发送、授权轮询。

- [pending-auth.js](./pending-auth.js)
  管理授权提醒失败后的 notice 状态、退避重试和本地持久化恢复。

- [openclaw.plugin.json](./openclaw.plugin.json)
  插件元信息和配置 schema。

## 理解主流程的最短路径

1. 看 [index.js](./index.js) 里的 `before_tool_call`
2. 看 [parse-meta.js](./parse-meta.js) 里的 `readLarkAuthFromContent`
3. 看 [utils.js](./utils.js) 里的 `checkScopes`
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

### 3. skill 识别依赖绝对路径索引

插件先扫描 skill 根目录，再把 `SKILL.md` 的绝对路径映射到 `skillName`。后续 `before_tool_call` 时会把 `read` 的 path 解析成绝对路径再做匹配。

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
