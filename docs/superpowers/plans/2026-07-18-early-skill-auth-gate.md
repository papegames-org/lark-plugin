# Early Skill Authorization Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize explicit OpenClaw skill commands before the model runs while retaining `SKILL.md` read interception as a compatibility fallback.

**Architecture:** Add an exact explicit-invocation resolver and a shared authorization preflight in `index.js`. Register `before_agent_run` as the primary gate, retain `before_tool_call`, and update installation/configuration documentation for OpenClaw's conversation-access policy.

**Tech Stack:** Node.js ESM, OpenClaw typed plugin hooks, `node:test`, npm packaging scripts.

---

### Task 1: Explicit invocation resolver and early gate

**Files:**
- Modify: `index.js`
- Test: `test/index.test.js`

- [ ] Write tests for canonical explicit invocation, unrelated prompts, missing authorization, and granted authorization.
- [ ] Run the focused tests and confirm the new cases fail.
- [ ] Add exact anchored prompt parsing and reverse skill lookup.
- [ ] Extract the existing authorization body into a shared preflight function.
- [ ] Register `before_agent_run` and return OpenClaw's `{ outcome: "block" }` decision when authorization is missing.
- [ ] Reuse the shared preflight from `before_tool_call`.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Installation and documentation

**Files:**
- Modify: installer implementation under `bin/` or its imported helper
- Modify: `README.md`
- Modify: `openclaw.plugin.json`
- Test: relevant installer/config tests

- [ ] Write a failing installer/config test for `hooks.allowConversationAccess=true`.
- [ ] Update installation config merging without overwriting unrelated settings.
- [ ] Document the primary gate, fallback, explicit `/skill` testing syntax, and compatibility behavior.
- [ ] Update plugin metadata descriptions to describe activation rather than only file reads.
- [ ] Run installer/config tests.

### Task 3: Verification and package

**Files:**
- No source files expected beyond fixes required by verification.

- [ ] Run `npm test`.
- [ ] Run `npm run release:check`.
- [ ] Run `npm run pack:local`.
- [ ] Inspect the generated archive name and contents.
- [ ] Report the package path and installation/restart commands.

