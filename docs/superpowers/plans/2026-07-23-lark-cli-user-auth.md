# Lark CLI 用户身份预授权 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在技能激活前准确校验应用身份/用户身份 scope，并以 lark-cli Device Flow 为单操作者提供用户授权卡。

**Architecture:** 应用侧继续直连飞书应用信息 API，但缓存完整 scope catalog 并按 `token_types` 校验身份。用户侧仅在 `userAuthProvider: lark-cli` 时经受控子进程调用 lark-cli；当前 profile 的 Device Flow 由内存 manager 去重、轮询复检并更新原授权卡。

**Tech Stack:** Node.js ESM、node:child_process、Node test runner、飞书 Open API、预装 lark-cli。

---

### Task 1: 为应用 scope catalog 建立失败测试

**Files:**
- Modify: `test/utils.test.js`
- Modify: `utils.js`

- [ ] **Step 1: 为 `token_types` 增加测试夹具**

覆盖以下 catalog：只有 `tenant`、只有 `user`、两者都有、scope 不存在、API 查询失败。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `npm test -- --test-name-pattern='application authorization'`

Expected: FAIL，因为尚未导出 `checkApplicationAuthorization`。

- [ ] **Step 3: 保留 scope catalog 并实现身份校验**

将应用 API 返回标准化为：

```js
{ scope, tokenTypes: Array.isArray(item.token_types) ? item.token_types : [], level: item.level }
```

新增：

```js
export async function checkApplicationAuthorization(scopes, identity, ctx) {
  // identity=app 要求 tenant；identity=user 要求 user。
  // 返回 { ok, missing, incompatible, granted, catalogUnavailable }。
}
```

- [ ] **Step 4: 运行目标测试并确认通过**

Run: `npm test -- --test-name-pattern='application authorization'`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add utils.js test/utils.test.js
git commit -m "feat: validate scope token types"
```

### Task 2: 实现受控 lark-cli adapter

**Files:**
- Create: `lark-cli-auth.js`
- Create: `test/lark-cli-auth.test.js`
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: 写 adapter 的失败测试**

以注入的 `spawn`/`execFile` fake 覆盖：profile 参数、`shell: false`、check 成功/缺失、login JSON、缺失 JSON 字段、bind 失败、超时与 stdout/stderr 脱敏。

- [ ] **Step 2: 运行 adapter 测试并确认失败**

Run: `node --test test/lark-cli-auth.test.js`

Expected: FAIL，因为模块不存在。

- [ ] **Step 3: 实现最小 adapter**

导出 `createLarkCliAuthAdapter({ execFile, spawn, cliPath, profile, timeoutMs })`，只支持：

```js
bind({ appId })
check({ scopes })
startDeviceFlow({ scopes }) // 严格解析 JSON 的 verification_url/device_code/expires_in
waitForDeviceFlow({ deviceCode, timeoutMs })
```

所有 auth 调用都使用 `lark-cli --profile <profile> ...`；`bind` 使用 `config bind --source openclaw --app-id <appId> --identity user-default`。profile 用 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` 验证。不得记录或返回到日志层以外的 token。

- [ ] **Step 4: 增加并校验配置 schema**

新增：

```json
"userAuthProvider": { "type": "string", "enum": ["context", "lark-cli"] },
"larkCliProfile": { "type": "string" },
"userAuthTimeoutSeconds": { "type": "integer", "minimum": 30, "maximum": 600 }
```

- [ ] **Step 5: 运行 adapter 测试**

Run: `node --test test/lark-cli-auth.test.js`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add lark-cli-auth.js test/lark-cli-auth.test.js openclaw.plugin.json
git commit -m "feat: add lark cli user auth adapter"
```

### Task 2A: 补足 CLI 契约与安全边界

**Files:**
- Modify: `lark-cli-auth.js`
- Modify: `test/lark-cli-auth.test.js`
- Modify: `utils.js`

- [ ] **Step 1: 实现并测试 capability check**

新增 `capabilityCheck()`：从受控配置得到 CLI 绝对路径，不信任未校验 PATH；按 CLI 路径和版本缓存检查 `auth check`、`auth login`、`config bind` 与 JSON Device Flow 字段。仅在 `identity: user && userAuthProvider === "lark-cli"` 分支调用，失败统一映射 `USER_GRANT_UNKNOWN`；`identity: app` 预检不得调用 CLI。测试未知路径与不兼容 CLI。

- [ ] **Step 2: 固定 profile 与进程生命周期契约**

所有 auth argv 都携带同一 `--profile`。每个 flow 串行执行 `capabilityCheck → bind → check → login`；`waitForDeviceFlow` 创建独立进程组、持续消耗 stdout/stderr，完成/取消/超时均杀掉整个组。测试不使用 shell、bind/login 串行和进程组清理。

- [ ] **Step 3: Commit**

```bash
git add lark-cli-auth.js utils.js test/lark-cli-auth.test.js
git commit -m "fix: harden lark cli authorization lifecycle"
```

### Task 3: 接入单 profile Device Flow manager 与卡片更新

**Files:**
- Modify: `utils.js`
- Modify: `feishu-runtime.js`
- Modify: `test/utils.test.js`

- [ ] **Step 1: 添加失败测试**

覆盖同 profile 同 scope 复用、不同 scope 返回 pending、不持久化 URL/code、成功后重新 `check`、超时清理、成功 PATCH 的方法/路径/卡片 payload、取消和超时 PATCH、卡片更新失败不影响真实授权状态。

- [ ] **Step 2: 运行相关测试并确认失败**

Run: `npm test -- --test-name-pattern='device flow|auth card update'`

Expected: FAIL。

- [ ] **Step 3: 实现 flow manager 与消息更新函数**

实现 `activeUserAuthFlows: Map<profile, flow>`。flow 只保存在内存；持有 `messageId`、scope hash、终止句柄，绝不写进 pending notice。flow 成功、取消、超时时都以 `PATCH /open-apis/im/v1/messages/{message_id}` 更新原卡；更新失败只记录脱敏信息。

- [ ] **Step 4: 运行相关测试并确认通过**

Run: `npm test -- --test-name-pattern='device flow|auth card update'`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add utils.js feishu-runtime.js test/utils.test.js
git commit -m "feat: manage lark cli device authorization"
```

### Task 4: 将预检状态机接入 hook

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`
- Modify: `pending-auth.js`

- [ ] **Step 1: 写 hook 失败测试**

覆盖：app identity 仅检查 `tenant` 且从不调用 CLI；user identity 缺 user token type 时紫色配置错误卡；应用通过但 CLI 未授权时橙色用户卡；CLI unknown 默认阻断；`USER_GRANT_PENDING` 不创建第二个 flow；pending notice 不含 flow 凭据。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `npm test -- --test-name-pattern='lark cli|token type|user grant pending'`

Expected: FAIL。

- [ ] **Step 3: 重构 `preflightAuthDeclaration`**

先调用 `checkApplicationAuthorization`，再按 `identity` 与 `userAuthProvider` 分支。保留 provider 未配置时的 context profile 兼容路径；lark-cli 路径仅以 adapter 的 `check` 作为授权完成事实来源。映射原因到现有卡片构造，并将 `USER_GRANT_UNKNOWN` / `USER_GRANT_PENDING` 安全阻断。所有授权卡都必须走 requireOpenId 发送路径：解析不到操作者 open_id 时阻断，绝不回退 chatId/群聊。

- [ ] **Step 4: 清理 pending auth 持久化字段**

确保 normalize/read/write 都拒绝 `verificationUrl`、`deviceCode`、`userCode`、`messageId` 等短期 flow 数据。lark-cli provider 永不进入旧 OAuth URL 或旧轮询路径；清除 legacy `startLogin` / `sendAuthCard` / `startWaitForAuth` 对 URL、code 与 scope query 的明文日志，并用日志捕获测试证明它们不会泄露。

- [ ] **Step 5: 运行目标测试并确认通过**

Run: `npm test -- --test-name-pattern='lark cli|token type|user grant pending'`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add index.js pending-auth.js test/index.test.js
git commit -m "feat: gate skills with lark cli user authorization"
```

### Task 5: 更新文档与全量验证

**Files:**
- Modify: `README.md`
- Modify: `openclaw.plugin.json`
- Modify: `test/feishu-runtime.test.js`

- [ ] **Step 1: 更新 README**

记录默认兼容 provider、`lark-cli` 启用配置、单操作者限制、三种卡片、首次授权和排查命令。标记 `userOAuthRedirectUri` 仅适用于旧 context/OAuth 路径。

- [ ] **Step 2: 补齐配置与回归测试**

验证 schema、新配置默认值和旧 OAuth URL 分支不会在 lark-cli 模式下调用。

- [ ] **Step 3: 运行完整验证**

Run: `npm test && npm run release:check`

Expected: 全部通过；若 `release:check` 因现有未提交的无关文件失败，记录原因而不修改无关文件。

- [ ] **Step 4: Commit**

```bash
git add README.md openclaw.plugin.json test/feishu-runtime.test.js
git commit -m "docs: explain lark cli authorization"
```

### Task 6: 单操作者手动 smoke test

**Files:**
- No code changes required

- [ ] **Step 1: 配置测试 skill**

设置 `identity: user` 和一个真实的用户身份 scope，启用 `userAuthProvider: lark-cli`。

- [ ] **Step 2: 首次触发**

Expected: 仅发送一张橙色 Device Flow 授权卡；日志与 pending JSON 不含 URL/code。

- [ ] **Step 3: 完成授权并验证**

Expected: 原卡更新成功；再次触发 skill 通过 `lark-cli auth check` 放行。

- [ ] **Step 4: 验证 app identity**

Expected: `identity: app` skill 永不调用 lark-cli 或发送 OAuth 卡。
