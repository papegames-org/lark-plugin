# openclaw-skill-runtime

一个面向 OpenClaw / 飞书通道的预授权插件。

它会在模型读取某个 skill 的 `SKILL.md` 之前，解析其中声明的飞书权限需求，并检查当前飞书应用是否已经具备这些 scope。若权限未齐，会先给用户发送飞书授权卡片，再根据配置决定是否拦截这次读取。

从当前版本开始，插件运行时不再拉起外部 CLI，而是直接通过飞书开放平台 HTTP 接口完成 scope 查询、授权链接生成与卡片发送。

## 为什么需要这个插件

企业在飞书上落地 AI Agent 时，每个 Skill（技能）都可能调用飞书开放平台 API，由此带来三个高频痛点：

1. **权限授权** — 企业内部 Skill 可能需要调用飞书开放平台 API、Lark CLI、AI 网关等多种第三方系统。每个系统各有鉴权方式，如果没有统一机制，要么权限过放开带来安全风险，要么权限不足导致技能中途失败，用户体验割裂。
2. **飞书卡片按钮交互** — 授权动作、确认操作都需要通过飞书卡片按钮来完成。如果每个 Skill 各自实现一套卡片交互逻辑，重复造轮子且难以维护。
3. **精准执行 Skill** — 传统模式下，"何时调用哪个 Skill"完全依赖大模型的判断，模型一旦选错就会导致流程中断或调用错误的能力，企业难以把控执行确定性和业务可靠性。

本插件一次性解决这三个问题，让企业可以专注在 Skill 业务本身，而不用关心权限、交互和执行调度的底层细节。

## 这个插件解决什么问题

很多 skill 在真正执行前，都会先读取 `SKILL.md` 来获取说明和元数据。如果 skill 依赖飞书权限，而这些权限还没授权，模型就可能在“尚未完成授权”的状态下继续往下走。

这个插件把权限检查前移到了 `read SKILL.md` 这一步，目标是：

- 在 skill 使用前就发现缺失的飞书 scope
- 主动给用户发送授权卡片，而不是等后续接口报错
- 在需要时直接阻止本次 `SKILL.md` 读取，避免绕过权限检查

## 工作方式

插件启动后会扫描 skill 目录，建立 `SKILL.md -> skillName` 的索引。

当 OpenClaw 准备调用 `read` 工具读取某个文件时，插件会：

1. 判断这次读取是否发生在飞书通道
2. 判断目标文件是否是某个 skill 的 `SKILL.md`
3. 解析 frontmatter 中声明的 `larkAuth`
4. 通过飞书开放平台接口查询当前飞书应用已拥有的 scope
5. 若 scope 已齐全，则放行
6. 若存在缺失 scope，则发出飞书授权卡片
7. 若 `blockRead=true`，则直接阻止这次读取，要求用户完成授权后重试

授权卡片发出后，插件还会在后台轮询授权状态；一旦检测到授权完成，会再发送一张“授权完成”提示卡片。

如果缺权限已经判定成立，但授权卡片发送失败，插件会继续阻断本次读取，并把失败 notice 写入 OpenClaw 数据目录下的小型本地队列，按退避策略自动重试发送；重启后也会尝试恢复这部分失败重试状态。

## 目前支持的权限声明格式

插件会从 `SKILL.md` 的 frontmatter 中提取 `larkAuth`，当前兼容两种写法。

### 写法 1：`metadata.openclaw.larkAuth`

```md
---
name: demo-skill
metadata: { "openclaw": { "larkAuth": { "identity": "user", "scopes": ["im:message", "contact:user.base:readonly"] } } }
---
```

### 写法 2：YAML 风格的 `larkAuth`

```md
---
name: demo-skill
larkAuth:
  identity: user
  scopes:
    - im:message
    - contact:user.base:readonly
---
```

只有当：

- `identity` 为 `user`
- `scopes` 非空

插件才会触发预授权逻辑。

## 默认扫描目录

若未额外配置，插件会扫描以下两个目录中的 `SKILL.md`：

- `~/.agents/skills`
- `<workspace>/skills`
- `~/.openclaw/workspace/skills`

扫描时会：

- 递归最多 4 层
- 跳过隐藏目录
- 跳过 `node_modules`
- 仅识别文件名为 `SKILL.md` 的文件

## 配置项

插件配置定义见 [openclaw.plugin.json](./openclaw.plugin.json)。

### `enabled`

- 类型：`boolean`
- 作用：总开关
- 默认行为：未显式关闭时启用

### `blockRead`

- 类型：`boolean`
- 作用：缺失权限时是否阻止本次技能前置读取或技能运行时触发
- 当前代码默认行为：`true`

说明：
`openclaw.plugin.json` 与当前实现都采用：

```js
const blockRead = cfg.blockRead !== false;
```

也就是不传时默认阻塞。

### `skillRoots`

- 类型：`string[]`
- 作用：覆盖默认扫描目录

## 运行依赖

本仓库本身很轻，运行时只依赖 Node.js 内置能力与飞书开放平台接口。

整体依赖包括：

- OpenClaw 插件运行环境
- 飞书 channel 上下文
- 当前飞书账号对应的 `appId` / `appSecret`

其中插件会直接调用飞书开放平台接口来完成：

- 查询飞书应用信息和已授权 scopes
- 发起增量授权确认链接
- 发送飞书交互卡片

## 安装与诊断

OpenClaw 插件安装包现在只包含运行时所需文件，不再带任何额外的 CLI 安装、诊断或 setup 包装脚本。

如果你是通过 `openclaw plugins install <tgz>` 安装插件，只需要关心插件包本身是否被正确加载即可。

## 最小接入示例

下面给一个从安装到首次触发授权的最小示例，方便直接对照接入。

### 1. 安装插件

如果你已经打好了插件包，可以直接安装：

```bash
openclaw plugins install ./openclaw-skill-runtime.tgz
```

如果你使用的安装包文件名不同，把上面的文件名替换成自己的实际路径即可。

### 2. 在 OpenClaw 配置里启用插件

在 OpenClaw 配置中加入插件配置。最小可用示例如下：

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "default": {
          "appId": "cli_xxx",
          "appSecret": "xxx"
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "openclaw-skill-runtime": {
        "enabled": true,
        "config": {
          "blockRead": true,
          "skillRoots": [
            "~/.agents/skills",
            "/path/to/your/workspace/skills"
          ]
        }
      }
    }
  }
}
```

说明：

- `appId` / `appSecret` 需要替换成当前飞书应用的真实配置
- `blockRead` 默认为 `true`，这里显式写出来是为了让配置意图更清晰
- `skillRoots` 可按需覆盖；如果不配，插件会按默认目录自动扫描

### 3. 准备一个声明 `larkAuth` 的 Skill

例如在 `skills/demo-skill/SKILL.md` 中写：

```md
---
name: demo-skill
larkAuth:
  identity: user
  scopes:
    - contact:user.base:readonly
---

读取用户基础资料并返回结果。
```

当模型读取这个 `SKILL.md` 时，插件会先检查当前飞书应用是否已具备 `contact:user.base:readonly`。

### 4. 重启 Gateway 并验证

插件安装、配置或代码更新后，都建议执行一次真正的 Gateway 重启，然后再检查运行时状态：

```bash
openclaw plugins inspect openclaw-skill-runtime --runtime --json
openclaw gateway status --require-rpc
openclaw logs --follow
```

如果配置与运行时都正常，后续首次读取需要授权的 `SKILL.md` 时，就会先收到飞书授权卡片。

## OpenClaw 网关接入与验证

推荐按下面顺序接入：

1. 安装插件
2. 在 `plugins.entries.openclaw-skill-runtime.config` 下填写配置
3. 启用插件
4. 重启 OpenClaw Gateway
5. 用 runtime inspect 验证插件是否真的加载成功

可参考的检查命令：

```bash
openclaw plugins inspect openclaw-skill-runtime --runtime --json
openclaw gateway status --require-rpc
openclaw logs --follow
```

建议重点关注下面几项对排查“为什么插件没生效”很有用的线索：

- `Plugin entry present`
- `Plugin enabled`
- `Plugin config present`
- `Plugin allowlisted`
- `Plugin runtime loaded`

如果后续要反馈问题，优先把这些结果和 Gateway 日志里以 `[openclaw-skill-runtime]` 开头的启动日志一起带上。

如果你改的是插件代码，而不是单纯改配置，建议做一次真正的 Gateway 重启，不要只依赖软刷新。

如果日志里出现下面几类报错，可以这样判断：

- `feishu runtime unavailable`：先检查 `channels.feishu` / `channels.feishu.accounts` 下是否配置了可用的 `appId` / `appSecret`
- `Gateway RPC reachable: no`：先看 Gateway 进程和 RPC
- `Plugin runtime loaded: no`：通常是插件未启用、未安装成功，或者改完代码后还没真正重启 Gateway

更多和 Gateway 行为有关的实现笔记见 [docs/openclaw-gateway-notes.md](./docs/openclaw-gateway-notes.md)。

## 代码结构

- [index.js](./index.js)：插件主入口，注册 hook 并拦截 `read`
- [pending-auth.js](./pending-auth.js)：授权提醒失败后的 notice 状态、退避重试和持久化恢复
- [parse-meta.js](./parse-meta.js)：解析 `SKILL.md` frontmatter，提取 `larkAuth`
- [utils.js](./utils.js)：日志、skill 扫描、路径解析、scope 检查、授权卡片发送、授权轮询
- [openclaw.plugin.json](./openclaw.plugin.json)：插件元数据和配置 schema

## 关键行为说明

### 1. 只拦 `read`

插件的主入口仍然是 `before_tool_call`。

默认情况下它优先处理 `toolName === "read"` 的 `SKILL.md` 读取；但如果当前运行时没有显式暴露 `read`，而是已经在 hook 上下文中明确给出了 skill 名称或已解析的 skill 快照，插件也会沿用同一套权限校验与发卡逻辑，在真正执行前拦住该 skill。

### 2. 只对飞书通道生效

若当前上下文不是 `feishu` channel，插件会直接跳过。

### 3. 授权失败时倾向保守

如果插件无法正常查到当前 app 已拥有的 scopes，它会把 skill 要求的 scope 全部视为“缺失”，避免误放行。

### 4. 授权卡片发送有冷却时间

同一个 skill、同一组缺失 scope，在 3 分钟内不会重复狂发卡片。

### 5. 发卡后仍可继续轮询

插件会在后台轮询授权结果；若检测到所需 scope 已全部授权，会主动再发一张成功提示卡片。

### 6. 发卡失败会自动重试

如果 `sendAuthCard` 失败，插件不会因为提醒没发出去就放行读取。

当前策略是：

- 本次读取继续阻断
- 把失败上下文写入本地 notice 队列
- 按退避间隔自动重试发卡
- 下次同 skill 再次触发读取时，也会顺手尝试恢复发送
- 如果连续失败到上限，会保留失败状态一段时间用于诊断，而不是无限重试

notice 文件默认会优先写到：

- `OPENCLAW_DATA_DIR/plugins/openclaw-skill-runtime/pending-auth-notices.json`
- 若未设置，则回退到 `OPENCLAW_HOME/plugins/openclaw-skill-runtime/pending-auth-notices.json`
- 再回退到 `~/.openclaw-data/plugins/openclaw-skill-runtime/pending-auth-notices.json`

如果某条 notice 已经进入 `exhausted`，用户再次触发同一个 skill 的读取时，插件会把它视为一次显式人工重试，重新尝试发起授权流程，而不是机械地等到 notice 自然过期。

## 适合阅读的顺序

如果你第一次看这个仓库，建议按下面顺序读：

1. [openclaw.plugin.json](./openclaw.plugin.json)
2. [index.js](./index.js)
3. [parse-meta.js](./parse-meta.js)
4. [utils.js](./utils.js)

## 参考

- 卡片参考链接：[baileyh8/hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)
- 飞书卡片 JSON 结构参考：[Feishu Cards Card JSON V2 Structure](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
- 插件结构思想参考：[larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)

## 开发补充

如果你是来维护这个插件，而不是单纯使用它，建议再看一眼 [AGENTS.md](./AGENTS.md)。
