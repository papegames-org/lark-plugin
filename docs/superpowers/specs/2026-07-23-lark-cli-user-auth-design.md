# Lark CLI 用户身份预授权设计

## 目标

让插件继续以每个 `SKILL.md` 的 `larkAuth` 为唯一声明源，并在技能激活前明确区分以下三种权限状态：

1. 应用身份 API 权限缺失。
2. 用户身份 API 权限未在应用侧开通。
3. 应用侧已具备用户身份 API 权限，但单操作者尚未完成 `lark-cli` 用户授权。

在第三种状态下，首次触发技能即发送飞书授权卡。卡片承载 `lark-cli` Device Flow 返回的授权地址；授权完成后刷新原卡并允许后续技能执行。

## 范围与约束

- 部署模型为“单操作者私有 Agent”：一个 OpenClaw 运行时、一个飞书应用账号、一个实际操作者。
- `lark-cli` 已由 OpenClaw 运行时预装；插件可以调用它，但不自行实现 OAuth 回调、授权码换 token 或 token 存储。
- 本插件仍是 OpenClaw hook 插件，不新增常驻 HTTP 服务，不扩展为通用权限中心。
- `identity: app` 不使用 `lark-cli`，也不触发用户 OAuth。
- 权限状态未知或 CLI 出错时保持现有安全倾向：默认阻断而不是放行。
- 授权卡只允许投递到已解析的单操作者 `open_id` 私聊；无法识别操作者时阻断，不退回群聊投递。

## 授权模型

### 应用侧 scope catalog

插件通过 `GET /open-apis/application/v6/applications/{appId}` 读取应用 scopes。每项保留：

```js
{
  scope: "approval:task:read",
  tokenTypes: ["user", "tenant"],
  level: 1
}
```

判定规则：

- `identity: "app"`：每个声明 scope 都必须存在且 `tokenTypes` 含 `tenant`。
- `identity: "user"`：每个声明 scope 都必须存在且 `tokenTypes` 含 `user`。

scope 不存在与 scope 存在但不支持声明身份必须作为不同原因记录和展示。

### 用户侧授权

对于 `identity: "user"`，应用侧检查通过后，插件默认使用当前绑定的 lark-cli profile。`context` 仅作为显式兼容配置保留，用于宿主已提供可读 user token profile 的场景：

```text
lark-cli config bind --source openclaw --app-id <appId> --identity user-default
lark-cli --profile <profile> auth check --scope "<scope list>"
```

若 `auth check` 未通过，启动 Device Flow：

```text
lark-cli --profile <profile> auth login --scope "<missing scopes>" --no-wait --json
lark-cli --profile <profile> auth login --device-code <deviceCode>
```

第一条命令返回 `verification_url` 与 `device_code`。插件把 URL 包装为飞书 sidebar applink 后仅发送到已解析的操作者 `open_id` 私聊；第二条命令在后台等待 CLI 将用户 token 保存到单操作者的 profile 中。

CLI 命令仅通过参数数组与 `spawn` / `execFile` 启动，固定 `shell: false`。实现启动时执行一次 capability check，确认所需子命令和以下 JSON 字段可用：`verification_url`、`device_code`。无法解析 JSON 或命令退出非零一律为 `USER_GRANT_UNKNOWN`；不从文本输出中猜测 URL。`larkCliProfile` 必须匹配受限名称格式，且 lark-cli 的路径来自受控运行时配置而非不受限 PATH。

`larkCliProfile` 未配置时固定为 `openclaw`；配置值必须匹配 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`。除 `config bind`（该命令绑定 OpenClaw workspace）外，所有 `auth check`、`auth login` 和 device-code 等待调用都必须携带同一个 `--profile <profile>` 参数。

## 状态机

```text
SKILL.md larkAuth
  ├─ identity=app
  │   ├─ app scope + tenant token type 缺失 → APP_SCOPE_MISSING → 应用身份卡
  │   └─ 满足 → GRANTED
  └─ identity=user
      ├─ app scope 缺失 → USER_API_SCOPE_MISSING → 用户身份 API 权限卡
      ├─ scope 不支持 user token → TOKEN_TYPE_INCOMPATIBLE → 配置错误卡
      ├─ lark-cli auth check 通过 → GRANTED
      ├─ lark-cli auth check 未通过 → USER_GRANT_MISSING → Device Flow 用户授权卡
      └─ CLI 不可用/协议异常 → USER_GRANT_UNKNOWN → 诊断提示并阻断
```

`APP_SCOPE_MISSING` 与 `USER_API_SCOPE_MISSING` 继续复用当前的应用权限开通流程。只有 `USER_GRANT_MISSING` 进入 lark-cli Device Flow。

Device Flow 的“完成”唯一由 `lark-cli auth check --scope ...` 确认：后台 `auth login --device-code` 退出后，以及轮询期间，都重新执行该检查。不得再以 `ctx.authProfiles` 的旧值判断该 flow 是否完成。

## 模块边界

### `utils.js`

- 将 `getAppScopes` 升级为保留 `token_types` 的 catalog 查询与缓存。
- 引入单独的 `checkApplicationAuthorization(scopes, identity, ctx)`，不要复用仅比较字符串的 `checkScopes`。
- 新增最小 `lark-cli` adapter：只负责 bind、check、启动 Device Flow、等待 device code 完成、解析 JSON 输出和日志脱敏。
- 每个 CLI profile 同一时刻仅允许一个活跃 Device Flow。相同 scope 集合复用该 flow；不同 scope 集合返回 `USER_GRANT_PENDING` 并阻断、不发送第二张卡，待第一个 flow 结束后在下一次 skill 触发重新执行 `auth check` 并按需创建新 flow。单操作者不按 sender 建立 token 仓库。需要串行化对同一 profile 的 bind/login；超时后终止整个子进程组并持续消费 stdout/stderr，避免进程或缓冲泄漏。

### `index.js`

- `preflightAuthDeclaration` 先调用应用侧检查，再按 `identity` 决定是否调用用户 adapter。
- 将阶段从现有 `app_scope` / `user_grant` 扩展为具名原因，确保卡片、日志和 pending notice 使用一致的状态。
- 复用 `pendingAuthNotices` 处理卡片发送失败；但任何 Device Flow artifact（完整授权 URL、device code、user code、CLI 子进程状态）均不得写入 notice、日志或磁盘。卡片发送失败、插件重启或等待超时后，只能重新执行 `auth check`；仍未授权时创建新的 Device Flow。

### `feishu-runtime.js`

- 保留应用权限开通的 registration flow。
- 删除或弃用插件自行构造的用户 OAuth URL 路径；用户授权 URL 必须来自 lark-cli。
- 新增应用身份的消息卡更新封装：保存本次发送成功返回的 `messageId` 于内存 flow 状态，并以 `PATCH /open-apis/im/v1/messages/{message_id}` 更新原卡。更新失败只写脱敏日志，不影响已完成的 CLI 授权；下次触发时重新检查并放行或重新发卡。

### 配置与文档

- 新增 `userAuthProvider: "lark-cli"` 配置。为避免现有安装行为静默变化，未显式配置时维持现有 `ctx` profile 检查逻辑；配置为 `lark-cli` 才启用新 adapter。两条路径均无法确认授权时默认阻断。
- 可选配置：`larkCliProfile`、`userAuthTimeoutSeconds`。后者允许 `30–600` 秒，默认 `180` 秒；若 CLI JSON 返回 Device Flow 的 `expires_in`，有效等待上限为 `min(userAuthTimeoutSeconds, expires_in - 10)`，小于 30 秒则不启动 flow 并安全阻断。
- README 说明运行时前提、三类卡片、单操作者限制、所需 lark-cli 版本/能力和故障排查命令。原有 `userOAuthRedirectUri` 标为旧 provider 专用，不与 lark-cli provider 并用。

## 卡片体验

- 应用身份 scope 缺失：蓝色“飞书应用身份 API 权限开通提醒”。
- 用户身份 API scope 缺失：紫色“飞书用户身份 API 权限开通提醒”。
- 用户 token / grant 缺失：橙色“飞书当前用户授权提醒”，按钮文本“前往授权”。
- Device Flow 成功、取消、超时：若当前进程持有 `messageId` 则更新原消息卡；重启后没有该 ID 时不补发状态卡，下次触发从 `auth check` 重新开始。

## 错误处理与安全

- `lark-cli` 不存在、版本/能力不满足、bind 失败、输出无法解析或 device code 缺失：返回 `USER_GRANT_UNKNOWN`，记录已脱敏诊断信息，默认阻断。
- 子进程设置超时并在完成、取消、超时时清理；相同 scope 组合不得并发启动多条登录流程。
- 日志中不记录 access token、refresh token、完整授权 URL、device code、user code、scope 查询参数或 app secret。
- 仅使用 CLI 已持久化的单操作者 profile；插件不读取或复制 token。

## 测试策略

- scope catalog：缺 scope、仅 `tenant`、仅 `user`、两者都有、查询失败。
- adapter：CLI capability check、check 成功/失败、JSON login 成功、非 JSON 阻断、bind 失败、等待成功、登录退出后复检失败、等待取消、超时、重复去重、无 shell 参数注入。
- hook：三类卡片、`identity: app` 绝不启动 CLI、用户状态未知默认阻断、卡片发送失败的重试、Device Flow 凭据绝不进入 pending JSON 或日志、消息更新失败的回退。
- 手动 smoke test：单操作者首次触发 user skill 出卡并完成 Device Flow；重复触发不再出卡；app skill 从不出现 OAuth 卡。

## 非目标

- 不支持同一运行时中多个独立操作者的 user token 隔离。
- 不实现 OAuth callback server、token encryption store 或跨设备 token 同步。
- 不根据自然语言推断 skill 或 scope。
