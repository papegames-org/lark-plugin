import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  EXHAUSTED_NOTICE_TTL_MS,
  PENDING_AUTH_MAX_RETRIES,
  canRetryPendingAuthNotice,
  computePendingAuthRetryDelayMs,
  createPendingAuthNotice,
  bumpPendingAuthNoticeFailure,
  getPendingAuthNoticeStorePath,
  markPendingAuthNoticeExhausted,
  readPendingAuthNoticeStore,
  writePendingAuthNoticeStore,
} from "../pending-auth.js";

test("computePendingAuthRetryDelayMs uses bounded retry backoff", () => {
  assert.equal(computePendingAuthRetryDelayMs(1), 15000);
  assert.equal(computePendingAuthRetryDelayMs(2), 30000);
  assert.equal(computePendingAuthRetryDelayMs(5), 180000);
  assert.equal(computePendingAuthRetryDelayMs(99), 180000);
});

test("bumpPendingAuthNoticeFailure increments attempts and schedules the next retry", () => {
  const created = createPendingAuthNotice({
    authTargetKey: "acc-a::/tmp/skill-a/SKILL.md",
    skillName: "skill-a",
    skillPath: "/tmp/skill-a/SKILL.md",
    accountId: "acc-a",
    missing: ["im:message"],
    missingKey: "im:message",
    verificationUrl: "https://approve.example/a",
    deviceCode: "device-code",
    openId: "ou_123",
    lastError: "send failed",
  }, 1000);

  const bumped = bumpPendingAuthNoticeFailure(created, {
    openId: "ou_456",
    lastError: "still failed",
  }, 2000);

  assert.equal(bumped.attemptCount, 2);
  assert.equal(bumped.lastAttemptAt, 2000);
  assert.equal(bumped.nextRetryAt, 2000 + 30000);
  assert.equal(bumped.openId, "ou_456");
  assert.equal(bumped.status, "retrying");
});

test("createPendingAuthNotice keeps the card recipient but not an expiring device flow", () => {
  const notice = createPendingAuthNotice({
    authTargetKey: "acc-a::/tmp/skill-a/SKILL.md",
    skillName: "skill-a",
    skillPath: "/tmp/skill-a/SKILL.md",
    accountId: "acc-a",
    missing: ["im:message"],
    requiredScopes: ["im:message", "contact:user.base:readonly"],
    receiveId: "oc_group_chat",
    receiveIdType: "chat_id",
    oauthState: "scope_missing",
    verificationUrl: "https://approve.example/expired",
    deviceCode: "expired-device-code",
  }, 1000);

  assert.equal(notice.receiveId, "oc_group_chat");
  assert.equal(notice.receiveIdType, "chat_id");
  assert.equal(notice.oauthState, "scope_missing");
  assert.deepEqual(notice.requiredScopes, ["im:message", "contact:user.base:readonly"]);
  assert.equal("verificationUrl" in notice, false);
  assert.equal("deviceCode" in notice, false);
});

test("markPendingAuthNoticeExhausted stops retries after the max retry budget", () => {
  const exhausted = markPendingAuthNoticeExhausted({
    ...createPendingAuthNotice({
      authTargetKey: "acc-a::/tmp/skill-a/SKILL.md",
      skillName: "skill-a",
      skillPath: "/tmp/skill-a/SKILL.md",
      accountId: "acc-a",
      missing: ["im:message"],
      missingKey: "im:message",
      verificationUrl: "https://approve.example/a",
      lastError: "send failed",
    }, 1000),
    attemptCount: PENDING_AUTH_MAX_RETRIES,
  }, "permanent failure", 3000);

  assert.equal(exhausted.status, "exhausted");
  assert.equal(exhausted.nextRetryAt, null);
  assert.equal(exhausted.lastError, "permanent failure");
});

test("canRetryPendingAuthNotice allows an explicit retry after exhaustion", () => {
  const exhausted = markPendingAuthNoticeExhausted(createPendingAuthNotice({
    authTargetKey: "acc-a::/tmp/skill-a/SKILL.md",
    skillName: "skill-a",
    skillPath: "/tmp/skill-a/SKILL.md",
    accountId: "acc-a",
    missing: ["im:message"],
    missingKey: "im:message",
    verificationUrl: "https://approve.example/a",
    lastError: "send failed",
  }, 1000), "send failed", 2000);

  assert.equal(canRetryPendingAuthNotice(exhausted, { nowMs: 2000 }), false);
  assert.equal(canRetryPendingAuthNotice(exhausted, { nowMs: 2000, force: true }), true);
});

test("getPendingAuthNoticeStorePath prefers a stable OpenClaw data directory over tmpdir", () => {
  const filePath = getPendingAuthNoticeStorePath({
    env: { OPENCLAW_DATA_DIR: "/var/lib/openclaw-data" },
    homeDir: "/tmp/tester-home",
    tmpDir: "/tmp/ignored",
  });

  assert.equal(filePath, join("/var/lib/openclaw-data", "plugins", "openclaw-skill-runtime", "pending-auth-notices.json"));
});

test("readPendingAuthNoticeStore restores retrying notices and prunes stale exhausted ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-pending-auth-"));
  const filePath = join(dir, "pending-auth-notices.json");

  try {
    writePendingAuthNoticeStore(filePath, new Map([
      ["retrying", createPendingAuthNotice({
        authTargetKey: "retrying",
        skillName: "skill-a",
        skillPath: "/tmp/skill-a/SKILL.md",
        accountId: "acc-a",
        missing: ["im:message"],
        missingKey: "im:message",
        verificationUrl: "https://approve.example/a",
        lastError: "send failed",
      }, 1000)],
      ["exhausted", {
        ...createPendingAuthNotice({
          authTargetKey: "exhausted",
          skillName: "skill-b",
          skillPath: "/tmp/skill-b/SKILL.md",
          accountId: "acc-b",
          missing: ["im:message"],
          missingKey: "im:message",
          verificationUrl: "https://approve.example/b",
          lastError: "send failed",
        }, 1000),
        status: "exhausted",
        nextRetryAt: null,
        updatedAt: 1000,
      }],
    ]));

    const restored = readPendingAuthNoticeStore(filePath, {
      nowMs: 1000 + EXHAUSTED_NOTICE_TTL_MS + 1,
    });

    assert.equal(restored.size, 1);
    assert.ok(restored.has("retrying"));
    assert.ok(!restored.has("exhausted"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
