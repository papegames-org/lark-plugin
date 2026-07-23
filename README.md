# openclaw-skill-runtime

一个面向 OpenClaw / 飞书通道的预授权插件。

它把 `SKILL.md` 当作权限声明清单：明确调用某个 skill 时，优先在模型启动前解析其中的 `larkAuth` 并完成权限预检；模型自动选择 skill 时，则在首次读取对应 `SKILL.md` 前兜底检查。若任一层权限未齐，会先发送授权卡片，再按配置决定是否阻断本次 skill 继续执行。

## 它解决什么问题

这个仓库只做一件事：把飞书授权检查前移到 skill 使用之前。

这样做的价值很直接：

- 在 skill 真正执行前就发现缺失权限
- 统一复用飞书授权卡片，而不是每个 skill 各写一套
- 在需要时阻断继续执行，避免“未授权先调用”

它不是通用权限中心，也不是独立业务服务；边界保持得越小，行为越稳定。

## 工作方式

插件启动后会扫描 skill 目录，同时建立 `SKILL.md -> skillName` 和 `skillName -> SKILL.md` 索引。

插件支持两层门禁：

- 主门禁：OpenClaw 的明确 skill command 被改写成标准调用提示后，`before_agent_run` 在模型运行前完成预检。
- 兼容兜底：模型通过自然语言自动选择 skill 时，`before_tool_call` 在读取 `SKILL.md` 或执行带 `skillCommand` 的工具前完成预检。

两条路径最终执行同一套流程：

1. 确认当前请求来自飞书通道。
2. 找到对应的 `SKILL.md`。
3. 读取 frontmatter 里的 `larkAuth`。
4. 查询当前飞书应用已开通的 API scopes。
5. 若 `identity: user`，应用侧 scopes 通过后继续检查当前用户是否已授予这些 user scopes。
6. 若上述任一检查发现权限缺失，则按缺失阶段发送对应飞书授权卡片。
7. 若 `blockRead !== false`，则阻断模型启动、文件读取或技能继续执行。

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

只有当 `scopes` 非空时，插件才会触发预授权逻辑。

- `identity: app`
  检查应用侧 scope 是否已具备。
- `identity: user`
  先检查应用侧是否已开通对应用户身份 API scope，再检查当前用户是否已完成 OAuth 授权且 user token 未过期。

卡片会区分三类缺失：

- `app_scope + app`：应用身份 API 权限未开通，发送蓝色「飞书应用身份 API 权限开通提醒」。
- `app_scope + user`：用户身份 API 权限未在应用后台开通，发送紫色「飞书用户身份 API 权限开通提醒」。
- `user_grant + user`：应用权限已具备，但当前用户尚未授权，发送橙色「飞书当前用户授权提醒」。

注意：`user_grant + user` 可选两条闭环：默认 `context` provider 在配置 OAuth 回调地址时使用飞书用户 OAuth；未配置时会回退到兼容的 scope-grant 授权链接，以保证安装后仍能发送授权卡片。`lark-cli` provider 使用官方 CLI 的 Device Flow，不依赖上下文注入。

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
  作用：缺失权限时是否阻断本次 skill 激活、读取或执行；默认 `true`。名称为兼容旧配置而保留。
- `skillRoots`
  作用：覆盖默认 skill 扫描目录。
- `userOAuthRedirectUri`
  作用：生成飞书当前用户 OAuth 授权链接时使用的回调地址。也可放在 `channels.feishu.accounts.<id>.oauthRedirectUri` / `userOAuthRedirectUri`，或通过环境变量 `OPENCLAW_FEISHU_USER_OAUTH_REDIRECT_URI` 提供。
- `userAuthProvider`
  作用：当前用户授权链路。`lark-cli`（默认）使用官方 `@larksuite/cli` Device Flow；`context` 是显式兼容模式，从 hook 上下文读取用户授权 profile。
- `larkCliPath`
  作用：可选的 `lark-cli` 命令或绝对路径覆盖。默认直接调用 `lark-cli`，由运行环境的 `PATH` 自动发现；插件不会在运行时安装 CLI。CLI 缺失、不可执行或不支持 Device Flow 时，会保守阻断并提示修复运行环境。
- `toolAuth`
  作用：给非 skill 的裸工具调用声明权限需求，例如 `feishu_bitable_app`。插件只按显式配置拦截工具，不根据自然语言猜测工具属于哪个 skill。

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
- 安装助手会同时设置 `plugins.entries.openclaw-skill-runtime.hooks.allowConversationAccess=true`，这是 OpenClaw 允许第三方插件注册 `before_agent_run` 的安全开关
- 如果通过控制台或其他图形界面直接上传 `.tgz`，该安装助手不会运行；请在对应 OpenClaw 主机执行下面命令并重启 Gateway：

  ```bash
  openclaw config set plugins.entries.openclaw-skill-runtime.hooks.allowConversationAccess true
  openclaw gateway restart
  ```

- 插件启动时会检测该配置；若缺失会输出上述命令的明确 warning，但仍保留 `before_tool_call` 的 `SKILL.md` 读取兜底
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
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "blockRead": true,
          "userAuthProvider": "lark-cli",
          "larkCliPath": "lark-cli",
          "toolAuth": {
            "feishu_bitable_app": {
              "identity": "user",
              "scopes": ["base:app:create"]
            }
          },
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
- `hooks.allowConversationAccess` 用于启用模型运行前的明确 skill 调用门禁；插件不会记录完整对话内容
- `blockRead` 这里显式写出，是为了让策略更清楚
- `lark-cli` provider 会通过 `PATH` 发现 CLI，并使用当前激活的 CLI profile；它会先用 `auth check` 校验、使用 `config bind --source openclaw --app-id <appId> --identity user-default` 绑定当前应用，再经 `auth login --no-wait --json` 发起 Device Flow；用户完成卡片中的授权后，由 `--device-code` 等待完成。
- 如果使用默认 `context` provider，配置 `userOAuthRedirectUri`（且与飞书开放平台应用中的重定向 URL 一致）可启用完整的用户 OAuth 回调；未配置时插件会发送兼容的 scope-grant 授权卡片。
- `toolAuth` 用于“模型直接调用飞书工具、没有 skill 上下文”的场景；配置后插件看到对应工具调用时也会先做权限预检
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

明确执行时建议使用 OpenClaw 的 skill command：

```text
/skill demo-skill
```

此时插件会在模型运行前检查 `contact:user.base:readonly`。若由模型根据自然语言自动选择该 skill，则会在模型首次读取这个 `SKILL.md` 前兜底检查。

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

## 开发者补充说明

面向维护者的版本管理、npm 发布和公开仓库安全约束，已经单独整理到 [docs/developer-release.md](./docs/developer-release.md)。

如果你要发版、调整发布脚本，或排查 `release:check` / `release:publish`，请优先看这份文档。

## 关键行为

- 只对飞书通道生效；非飞书上下文会直接跳过
- 主入口是 `before_agent_run`，对 OpenClaw 明确解析出的 skill command 在模型运行前做授权门禁
- `before_tool_call` 是兼容兜底，拦截 `read SKILL.md` 和携带 `skillCommand` 的工具调用
- 不对“这个 skill”等自然语言做模糊猜测；无法获得确定 skill 信号时，必须等 OpenClaw 读取对应 `SKILL.md`
- 若 `getAppScopes` 失败，会把目标 scopes 全部视为缺失，策略上偏保守
- 授权卡片会用不同颜色和标题区分应用身份 API 权限、用户身份 API 权限和当前用户授权
- 当前用户授权可使用上下文 OAuth 或官方 `lark-cli` Device Flow；CLI 必须由运行环境预先安装并可从 `PATH` 发现
- 对裸工具调用只支持 `toolAuth` 显式配置，不做自然语言模糊匹配
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
