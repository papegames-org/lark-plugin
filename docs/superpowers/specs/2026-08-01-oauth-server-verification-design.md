# OAuth 服务端验证设计

## 背景

插件当前在运行时 checker 不可用时调用 `lark-cli auth check --scope ...`。该命令只比较本地保存 token 的 scope 字段，不能验证飞书服务端是否仍接受用户 access token。

实测：用户在飞书安全中心取消授权后，普通 `auth status` 仍显示 `tokenStatus: valid` 和历史 scope；`auth status --verify` 则返回 `identities.user.status: verify_failed`、`verified: false`，并包含 `[20005] invalid access token`。重新完成 Device Flow 后，`--verify` 返回 `verified: true`，且 scope 反映新 token 的实际授权范围。

## 目标

对 `larkAuth.identity: user` 的 Skill，只在用户 OAuth token 已通过服务端验证、且该 token 包含 Skill 所需全部 scope 时放行。

## 非目标

- 不改变 app / tenant 身份的 scope 校验策略。
- 不自行保存、刷新或解析 OAuth token。
- 不用真实业务 API 作为通用 OAuth 探针。

## 设计

### CLI fallback

当 OpenClaw runtime checker 不存在、抛错或返回不可用结果时，插件执行：

```text
lark-cli [--profile <configured-profile>] auth status --verify
```

其中 `--profile` 仅在 `OPENCLAW_SKILL_RUNTIME_LARK_PROFILE` 或 `LARK_PROFILE_NAME` 明确配置时附加；插件不假定 profile 名为 `openclaw`。

当前官方 CLI 的 `auth status` 默认输出 JSON，且不接受 `--json` flag；命令参数必须精确保持如上。

CLI 的 JSON 输出解析 `identities.user`，而绝不使用顶层 `identity` / `verified`：顶层字段可能表示仍可用的 bot 身份。

### 放行规则

仅同时满足以下条件时返回 `ok: true`：

1. `identities.user.available === true`；
2. `identities.user.verified === true`；
3. 输出顶层 `appId` 与当前 OpenClaw account 的 appId 匹配；
4. 当前入站用户 openId 必须可获得；若 status 含有用户凭据（已验证或 `verify_failed`），`identities.user.openId` 还必须与该入站用户匹配；
5. `identities.user.scope` 被拆分为完整 scope 集合后，涵盖请求的全部 scope。

`scope` 使用空白字符分隔，并在比较前去空、去重。缺失项为请求 scope 与该集合的差集。

CLI profile 是共享凭据。若当前 account appId 或入站用户 openId 无法取得，或任何已存在的 CLI 用户凭据不匹配，插件必须 fail closed 并归类为 `oauth_runtime_unavailable`，不得向该共享 profile 发卡或发起登录。`user: missing` 本身没有 CLI user openId 是预期状态：只要 appId 和入站用户可验证，它可以进入重新授权路径。此 fallback 因此只支持单用户 Gateway 或由运行时保证每个请求者有独立 profile 的部署；多用户共享 profile 不属于安全支持的配置。

### 失败分类

| 类别 | 判定 | 行为 |
| --- | --- | --- |
| `oauth_reauth_required` | 已解析的 user `missing`，或 `verify_failed` 且明确表明服务端拒绝 token（例如 `20005 invalid access token`） | 阻断并发送授权卡片；Device Flow 请求该 Skill 的全部必需 scope。 |
| `scope_missing` | user 已服务端验证，但 token scope 缺失部分 scope | 阻断并发送授权卡片；Device Flow 至少请求该 Skill 的全部必需 scope，不能只请求差集。 |
| `oauth_runtime_unavailable` | CLI 缺失、profile/config/keychain 不可用、网络失败、超时或 JSON 不可解析 | 安全阻断；不发送授权卡片，返回可诊断的运行时错误。 |
| `authorized` | 通过全部放行条件 | 放行。 |

`tokenStatus: valid`、token 过期时间以及 `auth check` 的结果都不作为 OAuth 服务端有效性的证据。插件先解析完整的 status JSON：已识别的 `missing` 或明确服务端拒绝 token 即使 CLI 非零退出也按相应授权路径处理；未知 `verify_failed` 原因、超时、部分或畸形 JSON，以及没有可分类完整状态的命令失败，一律归为 `oauth_runtime_unavailable`，而不是重新授权。

### Runtime checker 兼容

现有 OpenClaw runtime checker 仅当它同时明确返回服务端用户 token 验证证据（例如 `serverVerified: true`）、完整 granted scope 详情、及与请求参数相符的 `openId` 和 `appId` 时可放行；否则无论它是不存在、调用失败还是只有本地 scope 结果，都使用上面的 CLI fallback。这样本地/陈旧 checker 不会绕过已撤销 OAuth token，也不会跨用户或跨应用放行。

### 授权轮询

Device Flow 完成后的轮询也走同一验证入口。因此 device waiter 成功退出，或本地 CLI 已写入 token，都不代表授权完成；只有新的服务端验证、身份匹配及完整 scope 验证成功才完成。`oauth_runtime_unavailable` 在轮询中保持阻断并更新诊断，不转换为授权卡片。

## 测试

新增单元测试覆盖：

1. 服务端验证成功、应用/用户匹配且 scope 完整时放行；
2. 本地 `tokenStatus: valid` 但 `verified: false` / `20005` 时拒绝并触发重新授权；
3. 服务端验证成功但 scope 缺失时返回缺失 scope，且 login 请求完整 Skill scope；
4. 顶层 `verified: true` 且 user `verified: false` 时仍拒绝；
5. CLI / 配置 / keychain / 网络 / 无法解析输出时标记运行时不可用，不发卡、不启动 login；
6. CLI 返回 appId 或已存在用户凭据的 openId 与当前 account / 请求用户不匹配时安全阻断；user `missing` 在 appId 与入站用户匹配时可发送完整 scope 的登录请求；
7. 含 profile 配置时精确调用 `--profile <name> auth status --verify`，未配置时不伪造 `--profile openclaw`，且 OAuth 路径绝不调用 `auth check`；
8. runtime checker 的 `serverVerified` / scope 成功但 appId 或 openId 不匹配时不得放行；
9. device waiter 成功退出但新的 `status --verify` 未通过时，轮询不得完成授权。
