import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUserFacingFailureSummary,
  formatCardFailureHint,
  formatDiagnosticDownloadCardLine,
  buildDiagnosticDocument,
  getAuthDiagnosticDir,
} from "../auth-diagnostics.js";

test("formatUserFacingFailureSummary maps scope_missing", () => {
  const text = formatUserFacingFailureSummary({
    state: "cancelled",
    authReason: "user_grant",
    oauthState: "scope_missing",
    missingScopes: ["im:message", "contact:user.base:readonly"],
  });
  assert.match(text, /im:message/);
  assert.match(text, /缺少所需权限/u);
});

test("formatUserFacingFailureSummary maps registration denied", () => {
  const text = formatUserFacingFailureSummary({
    state: "cancelled",
    authReason: "app_scope",
    registrationError: "access_denied",
  });
  assert.match(text, /过期|拒绝|旧链接/u);
});

test("buildDiagnosticDocument includes timeline and build", () => {
  const doc = buildDiagnosticDocument({
    skillName: "demo-skill",
    authTargetKey: "default::/tmp/SKILL.md",
    state: "cancelled",
    authReason: "user_grant",
    build: "test-build",
    timeline: ["2026-01-01T00:00:00.000Z waiter exited"],
    lastCheckJson: '{"ok":false,"oauthState":"scope_missing"}',
  });
  assert.match(doc, /demo-skill/);
  assert.match(doc, /test-build/);
  assert.match(doc, /waiter exited/);
  assert.match(doc, /scope_missing/);
});

test("getAuthDiagnosticDir under openclaw-data", () => {
  const dir = getAuthDiagnosticDir({ env: { OPENCLAW_DATA_DIR: "/tmp/oc-data" }, homeDir: "/tmp", tmpDir: "/tmp" });
  assert.match(dir, /openclaw-skill-runtime[/\\]diagnostics$/);
});

test("formatCardFailureHint stays concise for cards", () => {
  const text = formatCardFailureHint({ oauthState: "oauth_reauth_required" });
  assert.match(text, /重新.*触发/u);
  assert.doesNotMatch(text, /Gateway|诊断 log|连续两次/u);
});

test("formatDiagnosticDownloadCardLine for replied delivery", () => {
  const line = formatDiagnosticDownloadCardLine({
    delivery: "replied",
    fileName: "demo-skill-2026.log",
  });
  assert.match(line, /demo-skill-2026\.log/);
  assert.match(line, /下方/u);
  assert.match(line, /下载/u);
});
