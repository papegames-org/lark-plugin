import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const PENDING_AUTH_NOTICE_SCHEMA_VERSION = 1;
export const PENDING_AUTH_RETRY_DELAYS_MS = [15000, 30000, 60000, 120000, 180000];
export const PENDING_AUTH_MAX_RETRIES = PENDING_AUTH_RETRY_DELAYS_MS.length;
export const PENDING_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
export const EXHAUSTED_NOTICE_TTL_MS = 30 * 60 * 1000;

export function resolvePendingAuthBaseDir(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || homedir();
  const tmpDir = options.tmpDir || tmpdir();
  const explicit = env.OPENCLAW_DATA_DIR || env.OPENCLAW_HOME || null;
  if (explicit) return explicit;
  if (homeDir) return join(homeDir, ".openclaw-data");
  return tmpDir;
}

export function getPendingAuthNoticeStorePath(options = {}) {
  const baseDir = resolvePendingAuthBaseDir(options);
  return join(baseDir, "plugins", "openclaw-skill-runtime", "pending-auth-notices.json");
}

export function computePendingAuthRetryDelayMs(attemptCount) {
  const index = Math.max(0, Math.min(PENDING_AUTH_RETRY_DELAYS_MS.length - 1, Number(attemptCount || 1) - 1));
  return PENDING_AUTH_RETRY_DELAYS_MS[index];
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes.map((scope) => normalizeString(scope)).filter(Boolean))];
}

export function createPendingAuthNotice(input, nowMs = Date.now()) {
  const missing = normalizeScopes(input?.missing);
  const authTargetKey = normalizeString(input?.authTargetKey);
  const skillName = normalizeString(input?.skillName);
  const skillPath = normalizeString(input?.skillPath);
  const accountId = normalizeString(input?.accountId);
  const verificationUrl = normalizeString(input?.verificationUrl);
  if (!authTargetKey || !skillName || !skillPath || !accountId || !verificationUrl || missing.length === 0) {
    return null;
  }

  const attemptCount = Math.max(1, Number(input?.attemptCount || 1));
  const status = input?.status === "exhausted" ? "exhausted" : "retrying";
  return {
    authTargetKey,
    skillName,
    skillPath,
    accountId,
    openId: normalizeString(input?.openId),
    identity: normalizeString(input?.identity),
    authReason: normalizeString(input?.authReason),
    missing,
    missingKey: normalizeString(input?.missingKey) || missing.slice().sort().join("|"),
    verificationUrl,
    userCode: normalizeString(input?.userCode),
    deviceCode: normalizeString(input?.deviceCode),
    status,
    attemptCount,
    lastAttemptAt: Number(input?.lastAttemptAt || nowMs),
    nextRetryAt: status === "retrying"
      ? Number(input?.nextRetryAt || (nowMs + computePendingAuthRetryDelayMs(attemptCount)))
      : null,
    lastError: normalizeString(input?.lastError),
    createdAt: Number(input?.createdAt || nowMs),
    updatedAt: Number(input?.updatedAt || nowMs),
  };
}

export function bumpPendingAuthNoticeFailure(notice, updates = {}, nowMs = Date.now()) {
  const nextAttemptCount = Math.max(1, Number(notice?.attemptCount || 0) + 1);
  return createPendingAuthNotice({
    ...notice,
    ...updates,
    status: "retrying",
    attemptCount: nextAttemptCount,
    lastAttemptAt: nowMs,
    nextRetryAt: nowMs + computePendingAuthRetryDelayMs(nextAttemptCount),
    updatedAt: nowMs,
    createdAt: notice?.createdAt || nowMs,
  }, nowMs);
}

export function markPendingAuthNoticeExhausted(notice, error, nowMs = Date.now()) {
  return createPendingAuthNotice({
    ...notice,
    status: "exhausted",
    nextRetryAt: null,
    lastError: normalizeString(error) || notice?.lastError,
    lastAttemptAt: nowMs,
    updatedAt: nowMs,
    createdAt: notice?.createdAt || nowMs,
  }, nowMs);
}

export function canRetryPendingAuthNotice(notice, options = {}) {
  if (!notice) return false;
  if (options.force === true) return true;
  if (notice.status !== "retrying") return false;
  if (notice.nextRetryAt == null) return false;
  const nowMs = Number(options.nowMs || Date.now());
  return notice.nextRetryAt <= nowMs;
}

function shouldKeepPendingAuthNotice(notice, nowMs) {
  if (!notice) return false;
  if ((nowMs - notice.updatedAt) > PENDING_NOTICE_TTL_MS) return false;
  if (notice.status === "exhausted" && (nowMs - notice.updatedAt) > EXHAUSTED_NOTICE_TTL_MS) return false;
  return true;
}

export function readPendingAuthNoticeStore(filePath, options = {}) {
  if (!existsSync(filePath)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return new Map();
  }

  const nowMs = Number(options.nowMs || Date.now());
  const rawNotices = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.notices) ? parsed.notices : [];
  const notices = new Map();
  for (const rawNotice of rawNotices) {
    const notice = createPendingAuthNotice(rawNotice, nowMs);
    if (!shouldKeepPendingAuthNotice(notice, nowMs)) continue;
    notices.set(notice.authTargetKey, notice);
  }
  return notices;
}

export function writePendingAuthNoticeStore(filePath, notices) {
  const entries = notices instanceof Map ? [...notices.values()] : [];
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: PENDING_AUTH_NOTICE_SCHEMA_VERSION,
    notices: entries,
  }, null, 2));
}
