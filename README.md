# openclaw-skill-runtime

一个面向 OpenClaw / 飞书通道的预授权插件。

它会在模型读取某个 skill 的 `SKILL.md` 之前，解析其中声明的 `larkAuth`，检查当前飞书应用是否已具备所需 scope；若权限未齐，会先发送授权卡片，再按配置决定是否阻断本次 skill 继续执行。

## 为什么需要这个插件

企业在飞书上落地 AI Agent 时，每个 Skill（技能）都可能调用飞书开放平台 API，由此带来三个高频痛点：

1. **权限授权** — 企业内部 Skill 可能需要调用飞书开放平台 API、Lark CLI、AI 网关等多种第三方系统。每个系统各有鉴权方式，如果没有统一机制，要么权限过放开带来安全风险，要么权限不足导致技能中途失败，用户体验割裂。
2. **飞书卡片按钮交互** — 授权动作、确认操作都需要通过飞书卡片按钮来完成。如果每个 Skill 各自实现一套卡片交互逻辑，重复造轮子且难以维护。
3. **精准执行 Skill** — 传统模式下，"何时调用哪个 Skill"完全依赖大模型的判断，模型一旦选错就会导致流程中断或调用错误的能力，企业难以把控执行确定性和业务可靠性。

本插件一次性解决这三个问题，让企业可以专注在 Skill 业务本身，而不用关心权限、交互和执行调度的底层细节。

## 它解决什么问题

这个仓库只做一件事：把飞书授权检查前移到 skill 使用之前。

这样做的价值很直接：

- 在 skill 真正执行前就发现缺失权限
- 统一复用飞书授权卡片，而不是每个 skill 各写一套
- 在需要时阻断继续执行，避免“未授权先调用”

它不是通用权限中心，也不是独立业务服务；边界保持得越小，行为越稳定。

## 工作方式

插件启动后会扫描 skill 目录，建立 `SKILL.md -> skillName` 的索引。

当 OpenClaw 即将读取某个 skill 的 `SKILL.md`，或运行时上下文已经明确指向某个 skill 时，插件会：

1. 确认当前请求来自飞书通道。
2. 找到对应的 `SKILL.md`。
3. 读取 frontmatter 里的 `larkAuth`。
4. 查询当前飞书应用已授权的 scopes。
5. 若 scopes 已齐全，则直接放行。
6. 若有缺失 scope，则发送飞书授权卡片。
7. 若 `blockRead !== false`，则阻断这次读取或技能继续执行。

授权卡片发出后，插件会继续轮询授权结果；若卡片发送失败，则会把失败 notice 写入本地持久化队列并按退避策略重试。

## 支持的 `larkAuth` 写法

写法 1：`metadata.openclaw.larkAuth`

```md
---
name: demo-skill
metadata: { "openclaw": { "larkAuth": { "identity": "user", "scopes": ["im:message", "contact:user.base:readonly"] } } }
---
```

写法 2：顶层 YAML `larkAuth`

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

若未额外配置，插件会扫描：

- `~/.agents/skills`
- `<workspace>/skills`
- `~/.openclaw/workspace/skills`

扫描策略：

- 最多递归 4 层
- 跳过隐藏目录
- 跳过 `node_modules`
- 仅识别文件名为 `SKILL.md` 的文件

## 配置项

配置定义见 [openclaw.plugin.json](./openclaw.plugin.json)。

- `enabled`
  作用：插件总开关；默认启用。
- `blockRead`
  作用：缺失权限时是否阻断本次读取或技能执行；默认 `true`。
- `skillRoots`
  作用：覆盖默认 skill 扫描目录。

当前实现和 schema 都采用：

```js
const blockRead = cfg.blockRead !== false;
```

也就是不传时默认阻断。

## 运行前提

插件本身零外部运行时依赖，但它默认运行在这些前提之上：

- OpenClaw hook API
- 飞书 channel 上下文
- `api.config.channels.feishu.accounts`
- 当前飞书账号对应的 `appId` / `appSecret`

插件会直接通过飞书开放平台 HTTP 接口完成：

- 查询飞书应用信息与已授权 scopes
- 生成增量授权链接
- 发送飞书交互卡片

对于 `identity=user` 的 Skill，插件还会补一层本地 `lark-cli` 绑定健康检查：

- 若存在与当前 OpenClaw `appId` 匹配的 profile，插件会在该 profile 下自动执行一次安全的 `bind` 自愈。
- 若 `profile list` 为空，插件使用 lark-cli 的 OpenClaw workspace 默认上下文执行 bind；若存在其它应用 profile 但没有匹配项，则保守阻断，避免绑定错误应用。
- 用户可见的 OAuth 入口始终应是飞书授权卡片；终端日志只用于排障，不作为最终用户操作入口。

## 安装

### To Human

先确认 npm 上能看到当前包：

```bash
npm view @jianguo_paper/openclaw-skill-runtime version --registry=https://registry.npmjs.org/
```

安装到本机 OpenClaw：

```bash
npx --registry=https://registry.npmjs.org/ @jianguo_paper/openclaw-skill-runtime@latest install-openclaw
```

如果想先看 helper CLI：

```bash
npx --registry=https://registry.npmjs.org/ @jianguo_paper/openclaw-skill-runtime@latest --help
```

说明：

- `install-openclaw` 会先在临时目录执行 `npm pack`，再调用 `openclaw plugins install <tgz>`
- 命令内部会使用临时 npm cache，避免宿主环境 `~/.npm` 权限问题卡住安装
- 安装完成后仍建议重启 Gateway 并做一次 runtime inspect

### To Agent

```text
请在装有 Node.js 和 OpenClaw CLI 的环境里执行下面几步：

1. 运行 `npm view @jianguo_paper/openclaw-skill-runtime version --registry=https://registry.npmjs.org/`，确认 npm 上能拿到版本号。
2. 运行 `npx --registry=https://registry.npmjs.org/ @jianguo_paper/openclaw-skill-runtime@latest --help`，确认 helper CLI 可用。
3. 运行 `npx --registry=https://registry.npmjs.org/ @jianguo_paper/openclaw-skill-runtime@latest install-openclaw`，把最新插件安装到本机 OpenClaw。
4. 运行 `openclaw plugins inspect openclaw-skill-runtime --runtime --json` 检查插件是否已加载。
5. 如果这次还改了插件配置或代码，再执行一次真正的 Gateway 重启，然后复查 runtime 状态。

如果任一步失败，请把 npm、openclaw install 和 runtime inspect 的终端输出完整返回。
```

## 最小接入

### 1. 启用插件配置

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

- `appId` / `appSecret` 需要替换成真实飞书应用配置
- `blockRead` 这里显式写出，是为了让策略更清楚
- `skillRoots` 不配置也能工作，只有需要覆盖默认扫描目录时才需要写

### 2. 准备一个声明 `larkAuth` 的 Skill

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

### 3. 重启并验证

插件安装、配置或代码更新后，都建议做一次真正的 Gateway 重启，然后执行：

```bash
openclaw plugins inspect openclaw-skill-runtime --runtime --json
openclaw gateway status --require-rpc
openclaw logs --follow
```

重点关注：

- `Plugin entry present`
- `Plugin enabled`
- `Plugin config present`
- `Plugin allowlisted`
- `Plugin runtime loaded`

常见排查线索：

- `feishu runtime unavailable`：优先检查 `channels.feishu.accounts` 下的 `appId` / `appSecret`
- `Gateway RPC reachable: no`：优先检查 Gateway 进程与 RPC
- `Plugin runtime loaded: no`：通常是插件未启用、未安装成功，或改完代码后还没真正重启 Gateway

更多 Gateway 侧笔记见 [docs/openclaw-gateway-notes.md](./docs/openclaw-gateway-notes.md)。

### 授权排查与发卡规则

- 插件使用 `lark-cli auth status --verify` 校验用户 OAuth，并要求 appId、openId、`identities.user.verified` 和完整 scope 同时匹配。
- 用户需要授权时，插件调用 `lark-cli auth login --scope ... --no-wait --json` 生成卡片链接，再由后台 `lark-cli auth login --device-code ...` 完成轮询、兑换和 token 持久化；插件不另存 OAuth token。
- 明确识别到用户令牌失效、撤权或缺少 scope 时，会发送重新授权/补充授权卡片；配置、网络、profile 或身份无法可靠判定时则保守阻断。
- 卡片会展示当前缺失的 scope；但用户补充授权及后续确认始终使用该 Skill 在 `larkAuth.scopes` 中声明的完整 scope 集合。

## 版本管理与 npm 发布

这是一个要发布到 npm 的公共工具，版本和公开发布约束需要固定下来。

### 版本管理规则

以下文件的版本号必须保持一致：

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`

现在可以直接运行：

```bash
npm run check:version
```

每次发布前，先升级版本号，例如：

```bash
npm version patch
```

升级后再同步检查以上文件是否一致。

### 发布前检查

```bash
npm run release:check
```

它会依次执行：

- `check:version`：检查关键 manifest 版本是否一致
- `test`：跑全部测试
- `check:public`：扫描敏感信息与高风险文件
- `pack:dry`：做一次 `npm pack --dry-run`

### 发布到 npm

```bash
export NPM_TOKEN="你的 npm token"
npm run release:publish
```

发布脚本会：

- 强制使用 `https://registry.npmjs.org/`
- 用临时 `.npmrc` 读取 `NPM_TOKEN`
- 先执行 `release:check`
- 发布结束后删除临时认证文件

## 公开仓库敏感信息扫描

`npm run check:public` 当前会重点拦这些风险：

- 私钥块、OpenAI key、GitHub PAT、Slack token、AWS key、npm token
- 明显像真实密钥的 `appSecret` / `client_secret` / `access_token` 赋值
- `.npmrc`、`.env`、`id_rsa`、`.pem`、`.key` 这类高风险文件
- 机器绝对路径、真实邮箱这类容易泄漏个人信息的内容

这层扫描不是万能的，但至少能在发布前先拦住一批最常见的公共仓库事故。

## 关键行为

- 只对飞书通道生效；非飞书上下文会直接跳过
- 主入口是 `before_tool_call`，优先拦 `read SKILL.md`
- 若运行时没有显式暴露 `read`，也会尝试从 hook 上下文里的 skill 信息回推目标 skill
- 若 `getAppScopes` 失败，会把目标 scopes 全部视为缺失，策略上偏保守
- 同一个 skill / scope 组合有发卡冷却，避免短时间重复刷卡
- 授权成功后会发完成提示卡片
- 发卡失败不会放行读取，而是写入本地 notice 队列继续重试

notice 持久化文件默认优先写到：

- `OPENCLAW_DATA_DIR/plugins/openclaw-skill-runtime/pending-auth-notices.json`
- `OPENCLAW_HOME/plugins/openclaw-skill-runtime/pending-auth-notices.json`
- `~/.openclaw-data/plugins/openclaw-skill-runtime/pending-auth-notices.json`

## 代码结构

- [index.js](./index.js)：插件入口与 hook 注册
- [parse-meta.js](./parse-meta.js)：从 `SKILL.md` 解析 `larkAuth`
- [utils.js](./utils.js)：扫描 skill、查 scope、发卡、轮询与缓存
- [pending-auth.js](./pending-auth.js)：失败 notice 的退避重试与持久化恢复
- [openclaw.plugin.json](./openclaw.plugin.json)：插件元信息与配置 schema

第一次阅读这个仓库，建议顺序：

1. [openclaw.plugin.json](./openclaw.plugin.json)
2. [index.js](./index.js)
3. [parse-meta.js](./parse-meta.js)
4. [utils.js](./utils.js)

## 参考

- 卡片参考链接：[baileyh8/hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)
- 飞书卡片 JSON 结构参考：[Feishu Cards Card JSON V2 Structure](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
- 插件结构思想参考：[larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)

如果你是来维护这个插件，而不是单纯使用它，建议再看一眼 [AGENTS.md](./AGENTS.md)。
