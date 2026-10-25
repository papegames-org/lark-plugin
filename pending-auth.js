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
  const requiredScopes = normalizeScopes(input?.requiredScopes);
  const authTargetKey = normalizeString(input?.authTargetKey);
  const skillName = normalizeString(input?.skillName);
  const skillPath = normalizeString(input?.skillPath);
  const accountId = normalizeString(input?.accountId);
  if (!authTargetKey || !skillName || !skillPath || !accountId || missing.length === 0) {
    return null;
  }

  const attemptCount = Math.max(1, Number(input?.attemptCount || 1));
  const status = input?.status === "exhausted" ? "exhausted" : "retrying";
  return {
    authTargetKey,
    skillName,
    skillPath,
    accountId,
    requesterKey: normalizeString(input?.requesterKey),
    openId: normalizeString(input?.openId),
    receiveId: normalizeString(input?.receiveId),
    receiveIdType: normalizeString(input?.receiveIdType),
    identity: normalizeString(input?.identity),
    authReason: normalizeString(input?.authReason),
    oauthState: normalizeString(input?.oauthState),
    missing,
    requiredScopes: requiredScopes.length ? requiredScopes : missing,
    missingKey: normalizeString(input?.missingKey) || missing.slice().sort().join("|"),
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

export const AUTH_CARD_RECORD_SCHEMA_VERSION = 1;
export const AUTH_CARD_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getAuthCardRecordStorePath(options = {}) {
  const baseDir = resolvePendingAuthBaseDir(options);
  return join(baseDir, "plugins", "openclaw-skill-runtime", "auth-card-records.json");
}

function shouldKeepAuthCardRecord(record, nowMs = Date.now()) {
  if (!record?.authTargetKey || !record?.authMessageId) return false;
  const updatedAt = Number(record.updatedAt || record.createdAt || 0);
  if (!updatedAt) return true;
  return nowMs - updatedAt <= AUTH_CARD_RECORD_TTL_MS;
}

export function readAuthCardRecordStore(filePath, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const records = new Map();
  if (!filePath || !existsSync(filePath)) return records;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return records;
  }
  const rawRecords = Array.isArray(parsed?.records) ? parsed.records : [];
  for (const raw of rawRecords) {
    const authTargetKey = normalizeString(raw?.authTargetKey);
    const authMessageId = normalizeString(raw?.authMessageId);
    const skillName = normalizeString(raw?.skillName);
    if (!authTargetKey || !authMessageId || !skillName) continue;
    const record = {
      authTargetKey,
      authMessageId,
      skillName,
      accountId: normalizeString(raw?.accountId),
      authReason: normalizeString(raw?.authReason),
      requesterKey: normalizeString(raw?.requesterKey),
      deviceCode: normalizeString(raw?.deviceCode),
      missingKey: normalizeString(raw?.missingKey),
      missing: normalizeScopes(raw?.missing),
      requiredScopes: normalizeScopes(raw?.requiredScopes),
      scopeInstallGrant:
        raw?.scopeInstallGrant && typeof raw.scopeInstallGrant === "object" && !Array.isArray(raw.scopeInstallGrant)
          ? raw.scopeInstallGrant
          : null,
      identity: normalizeString(raw?.identity),
      openId: normalizeString(raw?.openId),
      larkProfile: normalizeString(raw?.larkProfile),
      cardFinalized: raw?.cardFinalized === true,
      createdAt: Number(raw?.createdAt || nowMs),
      updatedAt: Number(raw?.updatedAt || nowMs),
    };
    if (!shouldKeepAuthCardRecord(record, nowMs)) continue;
    records.set(authTargetKey, record);
  }
  return records;
}

export function writeAuthCardRecordStore(filePath, records) {
  const entries = records instanceof Map ? [...records.values()] : [];
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: AUTH_CARD_RECORD_SCHEMA_VERSION,
    records: entries,
  }, null, 2));
}

export function upsertAuthCardRecord(filePath, input, nowMs = Date.now()) {
  const authTargetKey = normalizeString(input?.authTargetKey);
  const authMessageId = normalizeString(input?.authMessageId);
  const skillName = normalizeString(input?.skillName);
  if (!filePath || !authTargetKey || !authMessageId || !skillName) return null;
  const records = readAuthCardRecordStore(filePath, { nowMs });
  const previous = records.get(authTargetKey);
  const next = {
    authTargetKey,
    authMessageId,
    skillName,
    accountId: normalizeString(input?.accountId) || previous?.accountId || null,
    authReason: normalizeString(input?.authReason) || previous?.authReason || null,
    requesterKey: normalizeString(input?.requesterKey) || previous?.requesterKey || null,
    deviceCode: normalizeString(input?.deviceCode) || previous?.deviceCode || null,
    missingKey: normalizeString(input?.missingKey) || previous?.missingKey || null,
    missing: normalizeScopes(input?.missing)?.length
      ? normalizeScopes(input?.missing)
      : (previous?.missing || []),
    requiredScopes: normalizeScopes(input?.requiredScopes)?.length
      ? normalizeScopes(input?.requiredScopes)
      : (previous?.requiredScopes || []),
    scopeInstallGrant:
      input?.scopeInstallGrant && typeof input.scopeInstallGrant === "object" && !Array.isArray(input.scopeInstallGrant)
        ? input.scopeInstallGrant
        : (previous?.scopeInstallGrant || null),
    identity: normalizeString(input?.identity) || previous?.identity || null,
    openId: normalizeString(input?.openId) || previous?.openId || null,
    larkProfile: normalizeString(input?.larkProfile) || previous?.larkProfile || null,
    cardFinalized: input?.cardFinalized === true ? true : (previous?.cardFinalized === true),
    createdAt: Number(previous?.createdAt || nowMs),
    updatedAt: nowMs,
  };
  records.set(authTargetKey, next);
  writeAuthCardRecordStore(filePath, records);
  return next;
}

export function removeAuthCardRecord(filePath, authTargetKey, nowMs = Date.now()) {
  const key = normalizeString(authTargetKey);
  if (!filePath || !key) return;
  const records = readAuthCardRecordStore(filePath, { nowMs });
  if (!records.delete(key)) return;
  writeAuthCardRecordStore(filePath, records);
}
