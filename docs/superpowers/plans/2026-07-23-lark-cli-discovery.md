# Lark CLI Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the system `PATH` and active Lark CLI profile for Device Flow authorization, while failing closed when the CLI is unavailable and never installing software at runtime.

**Architecture:** Keep the existing `lark-cli-auth.js` adapter as the command boundary. Make its default executable `lark-cli`, omit profile arguments from every command, preserve the existing explicit executable override, and simplify callers/persistence/schema to remove automatic-install and profile propagation.

**Tech Stack:** Node.js ESM, `node:test`, `child_process.execFile` and `spawn`, npm packaging.

---

### Task 1: Define adapter behavior with failing tests

**Files:**
- Modify: `test/lark-cli-auth.test.js`
- Modify: `lark-cli-auth.js`

- [ ] **Step 1: Replace profile/install expectations with PATH discovery tests**

Add tests that require the default adapter to call `lark-cli auth login --help` and `lark-cli --version` with no `--profile`. Add a missing-command test whose `ENOENT` result produces `{ ok: false, error: "lark-cli unsupported" }` and never invokes npm. Preserve coverage for an absolute override and add coverage for a `lark-cli-custom` command-name override. Require the exact bind command (`config bind --source openclaw --app-id <id> --identity user-default`), auth check, device-flow start, and device-flow wait/spawn invocation to omit `--profile`.

- [ ] **Step 2: Run the adapter test to verify it fails**

Run: `node --test test/lark-cli-auth.test.js`

Expected: FAIL because the adapter currently requires absolute paths, passes `--profile`, and attempts npm installation.

- [ ] **Step 3: Implement minimal PATH/default-profile adapter behavior**

In `lark-cli-auth.js`, default `cliPath` to `lark-cli`; validate either a non-empty command name or absolute path; remove `autoInstall`, npm installation helpers, effective-profile state, and all `--profile` prefixes. Keep bind as `config bind --source openclaw --app-id <id> --identity user-default`; have check, device-flow start, and wait use the same unqualified command.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `node --test test/lark-cli-auth.test.js`

Expected: PASS.

### Task 2: Remove obsolete plugin propagation and persistence

**Files:**
- Modify: `utils.js`
- Modify: `index.js`
- Modify: `pending-auth.js`
- Modify: `test/pending-auth.test.js`
- Modify: `test/utils.test.js`

- [ ] **Step 1: Write failing persistence tests**

Replace the pending-notice test that expects profile and automatic-install state to persist with one that asserts retry retains `userAuthProvider` and optional `larkCliPath` (including a command-name override such as `lark-cli-custom`), but drops `larkCliProfile` and `installLarkCliIfMissing`. Update call-site assertions as needed to require adapter defaults.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test test/pending-auth.test.js test/utils.test.js`

Expected: FAIL because obsolete fields are currently stored and propagated.

- [ ] **Step 3: Implement minimal caller and persistence cleanup**

Remove `larkCliProfile` and `installLarkCliIfMissing` parameters from `index.js`, `utils.js`, and `pending-auth.js`; preserve the optional `larkCliPath` override and `userAuthProvider` in retry notices so a restarted retry continues through Lark CLI rather than incorrectly falling back to context authorization. Update pending-notice normalization to retain either a command name or an absolute executable path. Ensure retry/polling use the CLI active/default profile.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/pending-auth.test.js test/utils.test.js`

Expected: PASS.

### Task 3: Align public configuration and documentation

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `README.md`
- Modify: `test/index.test.js` (only if schema behavior is covered)

- [ ] **Step 1: Add/update failing schema expectation**

Add a direct manifest test that parses `openclaw.plugin.json`, requires `larkCliProfile` and `installLarkCliIfMissing` to be absent, requires `larkCliPath` to remain available, and verifies `additionalProperties: false` means the removed keys are invalid.

- [ ] **Step 2: Run the focused schema test to verify it fails**

Run: `node --test test/index.test.js`

Expected: FAIL because the removed schema keys are currently present.

- [ ] **Step 3: Remove stale public configuration and update documentation**

Remove `larkCliProfile` and `installLarkCliIfMissing` from `openclaw.plugin.json`. Update README text and examples to state that `lark-cli` is discovered through `PATH`, uses its active/default profile, and missing/incompatible CLI blocks the authorization gate without installation.

- [ ] **Step 4: Run all automated tests**

Run: `npm test`

Expected: PASS with no test failures.

### Task 4: Produce and inspect the installable package

**Files:**
- Verify: `package.json`
- Verify: `package-lock.json`
- Output: npm package tarball created by `npm pack`

- [ ] **Step 1: Run release validation**

Run: `npm run release:check`

Expected: PASS for version consistency, tests, public-content checks, and dry-run packaging.

- [ ] **Step 2: Create the package archive**

Run: `npm pack`

Expected: one `jianguo_paper-openclaw-skill-runtime-<version>.tgz` archive in the repository root.

- [ ] **Step 3: Inspect the generated archive**

Run: `tar -tzf <generated-archive>`

Expected: package contains the updated adapter, schema, README, and no unexpected sensitive files.

- [ ] **Step 4: Commit implementation changes**

Run: `git add lark-cli-auth.js utils.js index.js pending-auth.js openclaw.plugin.json README.md test/lark-cli-auth.test.js test/pending-auth.test.js test/utils.test.js` followed by `git commit -m "fix: discover lark cli without runtime install"`.
