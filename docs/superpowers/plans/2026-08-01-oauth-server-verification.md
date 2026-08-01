# OAuth Server Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CLI fallback's local `auth check` decision with a server-verified user OAuth status check while preserving the existing Feishu authorization-card workflow.

**Architecture:** `utils.js` will expose one normalized user-OAuth result from either a strongly attested runtime checker or `lark-cli auth status --verify`. The result carries an explicit state (`authorized`, `oauth_reauth_required`, `scope_missing`, or `oauth_runtime_unavailable`) so `index.js` can decide whether to send/retry a card, block only, or permit access. Card retries and polling will re-evaluate this same result against the full Skill scope list.

**Tech Stack:** Node.js ESM, `node:test`, existing OpenClaw hook runtime, `lark-cli`, existing Feishu card helpers.

---

### Task 1: Add normalized CLI OAuth-status parsing

**Files:**
- Modify: `utils.js:487-525`
- Modify: `test/utils.test.js:261-360`

- [ ] **Step 1: Write failing tests for a verified CLI user result**

Add a test that injects a runner returning this status payload and calls `checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "a" })` with mocked app-id resolution:

```js
{
  appId: "cli_app",
  identities: {
    user: {
      status: "ready", available: true, verified: true,
      openId: "ou_requester", scope: "scope:a scope:b offline_access",
    },
  },
}
```

Assert `ok === true`, `granted` is the requested two scopes, `missing` is empty, `source === "lark-cli-status"`, and runner calls are exactly `[["--version"], ["auth", "status", "--verify"]]`; assert no argument contains `auth check` or `--json`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/utils.test.js --test-name-pattern "server-verified CLI user"`

Expected: FAIL because the implementation still invokes `auth check` and cannot interpret `identities.user`.

- [ ] **Step 3: Implement minimal normalized CLI status result and context plumbing**

Replace `checkUserGrantViaLarkCli`'s `auth check` call with `auth status --verify`. Change its signature to receive the requester `openId` and `ctx`, and thread both from every fallback call site so it can resolve and compare the selected account appId before returning a positive result.

Add small pure helpers near it:

```js
function normalizeScopes(raw) {
  return [...new Set(String(raw || "").split(/\s+/u).map((s) => s.trim()).filter(Boolean))];
}

function makeOauthUnavailable(scopes, reason, extra = {}) {
  return { ok: false, missing: scopes, granted: [], unavailable: true,
    oauthState: "oauth_runtime_unavailable", reason, ...extra };
}
```

Parse complete JSON before considering command exit status. Accept only `identities.user.available === true`, `identities.user.verified === true`, matching appId/openId, and all requested scopes. Return `oauthState: "authorized"` or `"scope_missing"` with the actual scope difference. Never inspect top-level `verified`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/utils.test.js --test-name-pattern "server-verified CLI user"`

Expected: PASS.

- [ ] **Step 5: Commit the focused change**

Use `git diff -- utils.js test/utils.test.js` to identify only task-owned hunks. This worktree is already dirty; do not stage an entire shared file without confirming unrelated changes are excluded.

### Task 2: Classify revoked, missing, mismatched, and unavailable OAuth states

**Files:**
- Modify: `utils.js:487-525,929-968`
- Modify: `test/utils.test.js`

- [ ] **Step 1: Write failing table-driven tests for negative states**

Cover these exact outcomes:

```js
// Explicit revocation with a bound profile: classified for reauthorization.
{ appId: "cli_app", identities: { user: { status: "verify_failed", available: false,
  verified: false, openId: "ou_requester",
  message: "server rejected token: [20005] invalid access token" } } }
// First-time user: classified for reauthorization when app + requester are known.
{ appId: "cli_app", identities: { user: { status: "missing", available: false } } }
// A bot may be verified, but user failure never passes.
{ identities: { bot: { verified: true }, user: { status: "verify_failed", verified: false } } }
// Config / keychain / timeout / malformed output remain unavailable.
{ ok: false, error: { type: "config", message: "not configured" } }
```

Also test mismatching top-level appId and existing `identities.user.openId` both return unavailable; missing inbound requester openId also returns unavailable. Assert recognized revocation/missing statuses still classify correctly when process exit is nonzero but valid JSON exists.

- [ ] **Step 2: Run the focused failure tests and verify they fail**

Run: `node --test test/utils.test.js --test-name-pattern "OAuth status (revocation|missing|mismatch|unavailable)"`

Expected: FAIL because old fallback treats all CLI failures as generic missing scopes/unavailable.

- [ ] **Step 3: Implement deterministic OAuth classification**

Extend normalized results with `oauthState`:

```js
// user missing + verified account/requester context
{ ok: false, oauthState: "oauth_reauth_required", missing: requestedScopes }
// recognized server rejection (including 20005)
{ ok: false, oauthState: "oauth_reauth_required", missing: requestedScopes }
// verified user but scope delta
{ ok: false, oauthState: "scope_missing", missing: scopeDelta }
// command/config/keychain/network/malformed/identity mismatch
{ ok: false, oauthState: "oauth_runtime_unavailable", unavailable: true }
```

Resolve and compare the current account appId in the CLI path. Require incoming `openId`; only require CLI `identities.user.openId` for existing user credentials, allowing its absence for `status: "missing"`. Preserve diagnostic error text in `reason` without logging tokens or URLs.

- [ ] **Step 4: Run focused tests and the entire utils suite**

Run:

```bash
node --test test/utils.test.js --test-name-pattern "OAuth status"
node --test test/utils.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the classification change**

Use reviewed hunk staging only (`git add -p`) if a commit is requested; never stage unrelated pre-existing edits.

### Task 3: Harden the runtime-checker fast path

**Files:**
- Modify: `utils.js:940-967`
- Modify: `test/utils.test.js`

- [ ] **Step 1: Write failing tests for checker attestation**

Test that checker `{ ok: true, granted: requested }` falls back to CLI because it lacks `serverVerified: true`. Test that a checker with `serverVerified: true` but a mismatched returned `openId` or `appId` also does not pass. Test a matching checker with `serverVerified: true`, matching identity/app and complete grants passes without CLI. Also test a matching server-verified checker whose grant list omits a requested scope: it must return normalized `scope_missing`, not discard a known server-side negative result.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test test/utils.test.js --test-name-pattern "runtime checker.*server verified"`

Expected: FAIL because current code accepts any normalized `ok` checker result.

- [ ] **Step 3: Require authenticated checker evidence**

Add a narrow `isServerVerifiedCheckerResult(response, openId, appId)` guard. It must require `response.serverVerified === true`, complete scope detail after normalization, and `response.openId === openId`, `response.appId === appId`. On any failure, log why and invoke the CLI status fallback.

- [ ] **Step 4: Run the focused tests and full utils suite**

Run:

```bash
node --test test/utils.test.js --test-name-pattern "runtime checker.*server verified"
node --test test/utils.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the checker hardening**

Use reviewed hunk staging only (`git add -p`) if a commit is requested; never stage unrelated pre-existing edits.

### Task 4: Integrate OAuth states with read blocking and card start

**Files:**
- Modify: `index.js:627-735`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing hook tests for each OAuth state**

Add tests where a user-identity Skill receives `checkUserGrant` results with the four `oauthState` values. Assert:

- `authorized` clears pending/gates and allows the read;
- `oauth_reauth_required` sends the existing authorization card and starts login with **all** `larkAuth.scopes`;
- `scope_missing` may display only the missing list but calls `startLogin(larkAuth.scopes, ...)`;
- `oauth_runtime_unavailable` blocks with diagnostic reason and never calls `startLogin`, `sendAuthCard`, or pending-notice retry.

Add card-payload assertions: `oauth_reauth_required` renders a reauthorization reason, `scope_missing` renders a missing-permission reason, and the subtype is retained in a pending notice.

- [ ] **Step 2: Run the focused integration tests and verify they fail**

Run: `node --test test/index.test.js --test-name-pattern "OAuth state"`

Expected: FAIL because current code treats all non-OK user-grant results as authorization-card candidates and passes `missing` to login.

- [ ] **Step 3: Implement state-aware user flow**

In the `identity === "user"` branch, handle unavailable before cache/card behavior. Use `missing` only for card presentation, but call `startLogin(larkAuth.scopes, ctx, { identity: "user", authReason: "user_grant", oauthState })`. Keep `requiredScopes: larkAuth.scopes` in every pending notice and waiter invocation. Add an OAuth subtype field to card payload/context so existing card builders can distinguish reauthorization from missing-scope wording without duplicating card transport.

- [ ] **Step 4: Run focused tests and full index suite**

Run:

```bash
node --test test/index.test.js --test-name-pattern "OAuth state"
node --test test/index.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the hook integration**

Use reviewed hunk staging only (`git add -p`) if a commit is requested; never stage unrelated pre-existing edits.

### Task 5: Revalidate card polling and persistent retries

**Files:**
- Modify: `utils.js:1251-1375`
- Modify: `index.js:387-439,671-734`
- Modify: `test/utils.test.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing tests for full-scope polling and stale pending notices**

Add a polling test where required scopes are `["scope:a", "scope:b"]`, the initial missing set is `["scope:b"]`, and post-login status only has `scope:b`; assert no `authorized` marker or completion card is produced.

Add pending-retry tests where stored notice becomes: (a) authorized, (b) runtime unavailable, and (c) app/user mismatch. Assert retry clears/stops the notice and never sends its stored URL. Add a test that a still-valid retry starts a fresh login before sending a card.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test test/utils.test.js --test-name-pattern "poll.*full scope"
node --test test/index.test.js --test-name-pattern "pending.*OAuth"
```

Expected: FAIL because polling uses `scopes` (initial difference) and retry directly reuses stored `verificationUrl`/`deviceCode`.

- [ ] **Step 3: Implement authoritative rechecks**

For `authReason === "user_grant"`, make `startWaitForAuth` invoke `checkUserGrant(openId, requiredScopes || scopes, ...)` and only set cache authorization after that full result is authorized. If the waiter exits while the result is unavailable, retain the blocked diagnostic rather than marking the card cancelled.

Refactor pending retry so it receives enough current hook context to call the same user OAuth classification. Before send: clear for authorized; stop/diagnose for unavailable/mismatch; otherwise start a new full-scope login and send only the newly generated card data. Persist OAuth subtype, full required scopes, and display missing scopes separately.

- [ ] **Step 4: Run focused tests and all tests**

Run:

```bash
node --test test/utils.test.js --test-name-pattern "poll.*full scope"
node --test test/index.test.js --test-name-pattern "pending.*OAuth"
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit retry and polling hardening**

Use reviewed hunk staging only (`git add -p`) if a commit is requested; never stage unrelated pre-existing edits.

### Task 6: Update user documentation and run release checks

**Files:**
- Modify: `README.md` (authorization troubleshooting / runtime behavior)
- Test: `test/utils.test.js`, `test/index.test.js`

- [ ] **Step 1: Write any missing documentation-facing regression test**

If a new public configuration option or card subtype is introduced, add a test for its documented default. Do not add an option merely to expose implementation details.

- [ ] **Step 2: Document operational diagnosis**

Explain that `lark-cli auth status` is local only; the plugin uses `auth status --verify`; a verified bot does not prove user OAuth; `20005 invalid access token` requests reauthorization; config/keychain/network failures block without an authorization card.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run check:version
npm run check:public
npm run pack:dry
```

Expected: all commands exit 0.

- [ ] **Step 4: Inspect the final diff and commit**

Run: `git diff --check && git status --short`

If a commit is requested, use `git diff` and `git add -p` to stage only task-owned hunks. Do not stage whole shared files because the worktree had pre-existing modifications.
