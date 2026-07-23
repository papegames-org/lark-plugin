# Default Lark CLI User Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lark-cli` Device Flow the default authorization path for `identity: user` skills, without requiring an OAuth redirect URI.

**Architecture:** Keep card delivery independent: the plugin continues to send cards through the existing app-identity OpenAPI fallback. Only user-grant detection and login initiation select the `lark-cli` adapter by default; an explicitly configured `context` provider retains the existing OAuth/scope-grant compatibility path.

**Tech Stack:** Node.js ESM, node:test, existing `lark-cli` adapter.

---

### Task 1: Default provider selection

**Files:**
- Modify: `index.js`
- Modify: `openclaw.plugin.json`
- Test: `test/index.test.js`

- [ ] Write a failing test proving an omitted `userAuthProvider` invokes the lark-cli authorization checker and passes `userAuthProvider: "lark-cli"` to `startLogin`.
- [ ] Keep a regression assertion that `identity: app` never invokes the lark-cli checker.
- [ ] Keep a regression assertion that explicit `context` retains its current OAuth/scope-grant behavior.
- [ ] Run the focused test and confirm it fails because the existing default uses `context`.
- [ ] Select `lark-cli` when the user-grant provider is omitted, retaining an explicit `context` override.
- [ ] Run the focused test and confirm it passes.

### Task 2: Configuration and documentation

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `README.md`

- [ ] Change the schema default and explain that `lark-cli` is the install-time default for user grants.
- [ ] Document `context` as an explicit compatibility option requiring its own OAuth/runtime integration.

### Task 3: Regression verification

**Files:**
- Test: `test/index.test.js`
- Test: `test/utils.test.js`

- [ ] Run the full test suite.
- [ ] Run version, public-content, and npm-pack dry checks.
