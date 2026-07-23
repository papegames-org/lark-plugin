# Explicit Skill Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block a known, explicitly named Skill before ArkClaw can call its underlying tool, even when the runtime does not inject the standard skill instruction into the agent prompt.

**Architecture:** Record only unambiguous Skill references from Feishu messages, keyed by OpenClaw session identity. `before_agent_run` consumes that reference and performs the existing `larkAuth` preflight, so authorization-card composition and scope checks stay unchanged. Natural-language fuzzy matching and arbitrary file names remain out of scope.

**Tech Stack:** Node.js ESM, node:test, OpenClaw hook API.

---

### Task 1: Regression coverage for an explicit Feishu skill request

**Files:**
- Modify: `test/index.test.js`
- Modify: `index.js`

- [ ] **Step 1: Write the failing test**

Register the plugin, send a `message_received` event containing `/skill feishu-auth-user-granted`, then invoke `before_agent_run` with a runtime prompt that lacks the injected `Use the ... skill` line. Assert the handler returns the existing block result and calls `sendAuthCard` with the known Skill.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/index.test.js --test-name-pattern='cached explicit'`

Expected: failure because no message-to-session Skill intent is retained.

- [ ] **Step 3: Implement the minimal session intent cache**

Add a private per-registration cache. On `message_received`, accept only strict `/skill <registered-name>` syntax, resolve against the existing skill map, and cache it by `sessionId`/`sessionKey`. In `before_agent_run`, use the standard runtime instruction first and fall back to that exact cached intent. Remove the cached intent after it is used.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/index.test.js --test-name-pattern='cached explicit'`

Expected: one passing test.

### Task 2: Full verification and Moss validation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Update the patch version consistently**

Increment all three release-version sources together.

- [ ] **Step 2: Run release verification**

Run: `npm run release:check`

Expected: version, tests, public-content, and package dry-run checks all pass.

- [ ] **Step 3: Package and validate in Moss**

Build a tgz, send it to Moss, install/restart only with user authorization, then issue `/skill feishu-auth-user-granted` without clicking an authorization action. Verify the first authorization card is emitted by this plugin and lists the complete declared scope set.
