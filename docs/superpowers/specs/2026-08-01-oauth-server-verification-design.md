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
lark-cli [--profile <configured-profile>] auth status --verify --json
```

其中 `--profile` 仅在 `OPENCLAW_SKILL_RUNTIME_LARK_PROFILE` 或 `LARK_PROFILE_NAME` 明确配置时附加；插件不假定 profile 名为 `openclaw`。

CLI 的 JSON 输出解析 `identities.user`，而绝不使用顶层 `identity` / `verified`：顶层字段可能表示仍可用的 bot 身份。

### 放行规则

仅同时满足以下条件时返回 `ok: true`：

1. `identities.user.available === true`；
2. `identities.user.verified === true`；
3. `identities.user.scope` 被拆分为完整 scope 集合后，涵盖请求的全部 scope。

`scope` 使用空白字符分隔。缺失项为请求 scope 与该集合的差集。

### 失败分类

| 类别 | 判定 | 行为 |
| --- | --- | --- |
| `oauth_reauth_required` | user `missing`、`verify_failed`，或服务端拒绝 token（例如 `20005 invalid access token`） | 阻断并发送授权卡片；Device Flow 请求该 Skill 的全部必需 scope。 |
| `scope_missing` | user 已服务端验证，但 token scope 缺失部分 scope | 阻断并发送授权卡片；仅请求缺失 scope。 |
| `oauth_runtime_unavailable` | CLI 缺失、profile/config/keychain 不可用、网络失败、超时或 JSON 不可解析 | 安全阻断；不发送授权卡片，返回可诊断的运行时错误。 |
| `authorized` | 通过全部放行条件 | 放行。 |

`tokenStatus: valid`、token 过期时间以及 `auth check` 的结果都不作为 OAuth 服务端有效性的证据。

### Runtime checker 兼容

现有 OpenClaw runtime checker 继续优先使用；只有它不存在、调用失败或返回无法可靠判定 scope 的结果时，才使用上面的 CLI fallback。Runtime checker 的可信成功结果保持兼容，以免在部署 lark-cli 前破坏已有运行时集成。

### 授权轮询

Device Flow 完成后的轮询也走同一验证入口。因此本地 CLI 已写入 token、但飞书服务端未接受 token 时，轮询不会把授权标记为成功。

## 测试

新增单元测试覆盖：

1. 服务端验证成功且 scope 完整时放行；
2. 本地 `tokenStatus: valid` 但 `verified: false` / `20005` 时拒绝并触发重新授权；
3. 服务端验证成功但 scope 缺失时仅返回缺失 scope；
4. 顶层 `verified: true` 且 user `verified: false` 时仍拒绝；
5. CLI / 配置 / keychain / 网络 / 无法解析输出时标记运行时不可用，且不被当成 scope 缺失；
6. 含 profile 配置时命令参数正确，未配置时不伪造 `--profile openclaw`。
