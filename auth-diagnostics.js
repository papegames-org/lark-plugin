import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePendingAuthBaseDir } from "./pending-auth.js";

export function getAuthDiagnosticDir(options = {}) {
  return join(
    resolvePendingAuthBaseDir(options),
    "plugins",
    "openclaw-skill-runtime",
    "diagnostics",
  );
}

function sanitizeFileToken(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 96);
}

export function formatUserFacingFailureSummary({
  state,
  authReason = "user_grant",
  oauthState = null,
  reason = null,
  registrationError = null,
  missingScopes = null,
  source = null,
  waiterExitCode = null,
  graceElapsedSec = null,
  elapsedSec = null,
} = {}) {
  const appScope = authReason === "app_scope";
  const missing = Array.isArray(missingScopes) ? missingScopes.filter(Boolean) : [];

  if (state === "timeout") {
    return appScope
      ? "应用权限开通轮询超时（约 3 分钟），请重新触发技能后再试。"
      : "用户授权轮询超时（约 3 分钟），请重新触发技能后再试。";
  }
  if (state === "oauth_runtime_unavailable" || oauthState === "oauth_runtime_unavailable") {
    return reason
      || "Gateway 上 OAuth 运行时不可用（lark-cli / profile / 网络），请运维检查后再试。";
  }
  if (oauthState === "scope_missing" || (missing.length > 0 && oauthState !== "oauth_reauth_required")) {
    const sample = missing.slice(0, 5).join("、");
    const suffix = missing.length > 5 ? ` 等 ${missing.length} 项` : "";
    return `当前用户 token 缺少所需权限：${sample}${suffix}。请用同一飞书账号重新授权。`;
  }
  if (oauthState === "oauth_reauth_required") {
    return "飞书服务端未接受当前用户 token（可能已失效或需重新登录），请重新触发技能并完成用户登录授权。";
  }
  if (registrationError === "access_denied" || registrationError === "expired_token") {
    return "应用开通码已被拒绝或已过期（常见于重复点击旧链接）。请重新触发技能获取新卡片，不要复用旧按钮。";
  }
  if (appScope && state === "cancelled") {
    return "应用权限开通未完成或被取消，请重新触发技能后再开通。";
  }
  if (!appScope && waiterExitCode !== null && waiterExitCode !== undefined) {
    const grace = Number.isFinite(graceElapsedSec) ? `（等待 verify ${graceElapsedSec}s 后仍失败）` : "";
    return `Gateway 未完成用户 token 换票/校验${grace}。飞书页面秒过只表示 consent，需在 Gateway 上由 lark-cli 写入 token。请重新触发技能；若反复失败请把诊断文件交给运维。`;
  }
  if (reason) return String(reason);
  return "授权未完成。请重新触发技能后再次完成卡片上的登录/开通步骤。";
}

/** 授权失败卡片上的单行用户提示（运维细节见诊断文件 / Gateway 日志）。 */
export function formatCardFailureHint({
  oauthState = null,
  registrationError = null,
  state = null,
} = {}) {
  if (registrationError === "access_denied" || registrationError === "expired_token") {
    return "请重新触发该 skill，并使用**新授权卡片**上的按钮（勿点历史消息里的旧链接）。";
  }
  if (oauthState === "oauth_runtime_unavailable" || state === "oauth_runtime_unavailable") {
    return "授权运行时暂不可用，请稍后重试；若持续失败请联系运维。";
  }
  if (oauthState === "scope_missing") {
    return "请重新触发该 skill 并完成授权；若仍失败，请确认开放平台已启用所需权限。";
  }
  return "请重新在对话里触发该 skill，使用**新授权卡片**上的按钮。";
}

/** @deprecated 诊断 log operator hints；不再展示在飞书卡片上 */
export function formatSuggestedActions(options = {}) {
  return formatCardFailureHint(options);
}

export function buildDiagnosticDocument({
  skillName,
  authTargetKey,
  state,
  authReason,
  build = "<unknown>",
  accountId = null,
  appId = null,
  openId = null,
  oauthState = null,
  reason = null,
  source = null,
  missingScopes = null,
  registrationStatus = null,
  registrationError = null,
  waiterExitCode = null,
  waiterSignal = null,
  graceElapsedSec = null,
  elapsedSec = null,
  timeline = null,
  lastCheckJson = null,
} = {}) {
  const header = [
    "openclaw-skill-runtime auth diagnostic",
    `generatedAt: ${new Date().toISOString()}`,
    `build: ${build}`,
    `skillName: ${skillName || "<none>"}`,
    `authTargetKey: ${authTargetKey || "<none>"}`,
    `state: ${state || "<none>"}`,
    `authReason: ${authReason || "<none>"}`,
    `accountId: ${accountId || "<none>"}`,
    `appId: ${appId || "<none>"}`,
    `openId: ${openId ? "<present>" : "<none>"}`,
    `oauthState: ${oauthState || "<none>"}`,
    `source: ${source || "<none>"}`,
    `reason: ${reason || "<none>"}`,
    `registrationStatus: ${registrationStatus || "<none>"}`,
    `registrationError: ${registrationError || "<none>"}`,
    `waiterExitCode: ${waiterExitCode ?? "<none>"}`,
    `waiterSignal: ${waiterSignal ?? "<none>"}`,
    `graceElapsedSec: ${graceElapsedSec ?? "<none>"}`,
    `elapsedSec: ${elapsedSec ?? "<none>"}`,
    `missingScopes: ${Array.isArray(missingScopes) && missingScopes.length ? missingScopes.join(", ") : "<none>"}`,
    "",
    "=== timeline ===",
  ];
  const body = Array.isArray(timeline) && timeline.length
    ? timeline
    : ["<no timeline recorded>"];
  const tail = [
    "",
    "=== last checkUserGrant (redacted) ===",
    lastCheckJson || "<none>",
    "",
    "=== operator hints ===",
    "- Compare Gateway: lark-cli auth status --verify (same profile as OPENCLAW_SKILL_RUNTIME_LARK_PROFILE)",
    "- Search gateway stdout for: checkUserGrant result / waitForAuth / scopeGrantDevicePoll",
  ];
  return [...header, ...body, ...tail].join("\n");
}

export function writeAuthDiagnosticFile(payload, options = {}) {
  const dir = getAuthDiagnosticDir(options);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${sanitizeFileToken(payload?.authTargetKey || payload?.skillName)}-${ts}.log`;
  const path = join(dir, fileName);
  const text = typeof payload?.document === "string"
    ? payload.document
    : buildDiagnosticDocument(payload);
  writeFileSync(path, text, "utf8");
  return { path, fileName, dir };
}

export function buildCardDiagnosticExcerpt(document, maxLen = 2400) {
  const raw = String(document || "").trim();
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}\n\n…（已截断，完整内容见下方可下载的诊断日志文件）`;
}

/** @typedef {"replied" | "sent" | "failed" | "skipped"} DiagnosticDeliveryStatus */

export function formatDiagnosticDownloadCardLine({
  delivery = "failed",
  fileName = null,
  error = null,
} = {}) {
  const label = fileName || "auth-diagnostic.log";
  if (delivery === "replied") {
    return `**可下载诊断日志：** 文件 \`${label}\` 已回复在本授权卡片**下方**，请在飞书对话里点击该文件消息下载（完整 timeline 与 checkUserGrant 结果）。`;
  }
  if (delivery === "sent") {
    return `**可下载诊断日志：** 文件 \`${label}\` 已通过机器人消息发送给你，请在对话中点击文件下载。`;
  }
  if (delivery === "skipped") {
    return "**诊断日志：** 内容为空，未生成可下载文件。";
  }
  const detail = error ? String(error).slice(0, 200) : "未知错误";
  return `**诊断日志未能发送到飞书**（${detail}）。运维仍可在 Gateway 主机查看本地诊断文件路径（见下方）。`;
}
