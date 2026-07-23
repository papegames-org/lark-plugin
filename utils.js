// utils.js — OpenClaw Skill Runtime 工具函数集
// 包含：日志、workspace 查找、skill-map 构建、auth 操作等（frontmatter 解析已移至 parse-meta.js）
// ============================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { beginScopeGrantFlow, beginUserOAuthFlow, callFeishuOpenApi, resolveFeishuBrand } from "./feishu-runtime.js";
import { createLarkCliAuthAdapter } from "./lark-cli-auth.js";

// ---------- 模块级状态（与 index.js register 共享）----------

/** workspace 缓存（按 sessionId） */
export const cachedWorkspaceBySession = new Map();
/** account 缓存（按 sessionId/sessionKey） */
export const cachedAccountBySession = new Map();
/** sender/openId 缓存（按 sessionId/sessionKey） */
export const cachedSenderBySession = new Map();
/** register 时拿到的 api.config 引用（权威来源，免读文件）
 *  导出为 let 绑定，index.js 通过 setApiConfigRef() 写入 */
export let apiConfigRef = null;
let runtimeHealthCache = null;
let pluginApiRef = null;
const APP_SCOPES_CACHE_TTL_MS = 15000;
const appScopesCache = new Map();
const appScopeCatalogCache = new Map();
const LARK_AUTH_CARD_ICON = {
  tag: "custom_icon",
  img_key: "img_v3_0013l_5b29ba19-9327-4eed-b5b9-3cd7f940494g",
};

/** 设置 api.config 引用（仅内部使用，由 register 在 index.js 调用） */
export function setApiConfigRef(val) {
  apiConfigRef = val;
}

export function setPluginApiRef(val) {
  pluginApiRef = val || null;
}

export function resetRuntimeCaches() {
  runtimeHealthCache = null;
  appScopesCache.clear();
  appScopeCatalogCache.clear();
}

// ---------- 日志 ----------

export function fileLog(msg) {
  console.log(`[openclaw-skill-runtime] ${new Date().toISOString()} ${msg}`);
}

export function logCtxSnapshotOnce(ctx) {
  if (!ctx || ctx.__larkScopeCtxLogged) return;
  try {
    Object.defineProperty(ctx, "__larkScopeCtxLogged", { value: true, enumerable: false, configurable: true });
  } catch {
    ctx.__larkScopeCtxLogged = true;
  }
  fileLog(`ctx snapshot=${JSON.stringify({
    accountId: ctx?.accountId,
    account: ctx?.account,
    senderId: ctx?.senderId,
    messageId: ctx?.messageId,
    sessionKey: ctx?.sessionKey,
    sessionId: ctx?.sessionId,
    agentId: ctx?.agentId,
    workspaceDir: ctx?.workspaceDir || null,
    channelId: ctx?.channelId,
    __allKeys: ctx ? Object.keys(ctx) : null,
  })}`);
}

// ---------- workspace 查找：只用 api.config（不读文件）----------

export function lookupWorkspaceByAgentId(agentId) {
  if (!agentId) return null;
  const cfg = apiConfigRef;
  const agent = cfg?.agents?.list?.find?.((a) => a?.id === agentId);
  const ws = agent?.workspace || cfg?.agents?.defaults?.workspace || null;
  fileLog(`workspace: lookup by agentId=${agentId} -> ${ws || "<empty>"}`);
  return ws;
}

// ---------- skill-map：workspace 只走 agentId -> openclaw.json ----------

export function resolveWorkspaceDir(ctx) {
  if (ctx?.workspaceDir) {
    cachedWorkspaceBySession.set(ctx.sessionId, ctx.workspaceDir);
    fileLog(`workspace: from ctx.workspaceDir=${ctx.workspaceDir}`);
    return ctx.workspaceDir;
  }
  if (ctx?.sessionId && cachedWorkspaceBySession.has(ctx.sessionId)) {
    const cached = cachedWorkspaceBySession.get(ctx.sessionId);
    fileLog(`workspace: from cache (sessionId=${ctx.sessionId}) -> ${cached}`);
    return cached;
  }
  fileLog(`workspace: no ctx.workspaceDir and no cache for agentId=${ctx?.agentId || "<empty>"} — returning null`);
  return null;
}

function getOpenClawHomeDir() {
  const candidates = [
    process.env.OPENCLAW_HOME,
    join(homedir(), ".openclaw"),
  ].filter((value) => typeof value === "string" && value.trim());
  return candidates.length ? expandHome(candidates[0]) : null;
}

export function getDefaultSkillRoots(ctx) {
  const ws = resolveWorkspaceDir(ctx);
  const roots = [
    join(homedir(), ".agents", "skills"),
  ];
  if (ws) roots.push(join(ws, "skills"));
  const openclawHome = getOpenClawHomeDir();
  if (openclawHome) roots.push(join(openclawHome, "workspace", "skills"));
  return [...new Set(roots.map((root) => resolve(expandHome(root))))];
}

export function resolveSkillReadTarget(rawPath, cwd, wsDir) {
  const abs = resolvePath(rawPath, cwd, wsDir);
  if (!abs || basename(abs) !== "SKILL.md") return null;
  const normalized = abs.replace(/\\/g, "/");
  if (!normalized.includes("/skills/")) return null;
  return {
    abs,
    skillName: basename(dirname(abs)),
  };
}

export function inferSenderIdFromCtx(ctx) {
  const candidates = [
    ctx?.senderId,
    ctx?.senderOpenId,
    ctx?.openId,
    ctx?.channelId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && /^ou_[A-Za-z0-9]/.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

export function cacheSenderId(ctx, senderId) {
  if (!senderId) return;
  if (ctx?.sessionId) cachedSenderBySession.set(ctx.sessionId, senderId);
  if (ctx?.sessionKey) cachedSenderBySession.set(ctx.sessionKey, senderId);
}

export function getCachedSenderId(ctx) {
  const direct = inferSenderIdFromCtx(ctx);
  if (direct) {
    return direct;
  }
  if (ctx?.sessionId && cachedSenderBySession.has(ctx.sessionId)) {
    return cachedSenderBySession.get(ctx.sessionId);
  }
  if (ctx?.sessionKey && cachedSenderBySession.has(ctx.sessionKey)) {
    return cachedSenderBySession.get(ctx.sessionKey);
  }
  return null;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolvePath(p, cwd, wsDir) {
  if (!p) return p;
  const e = expandHome(p);
  if (e.startsWith("/")) return resolve(e);
  const base = wsDir || cwd || process.cwd();
  return resolve(base, e);
}

export function findSkillMds(root, out, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      findSkillMds(full, out, depth + 1);
    } else if (ent.isFile() && ent.name === "SKILL.md") {
      out.set(resolve(full), basename(dirname(full)));
    }
  }
}

export function buildSkillMap(roots) {
  const map = new Map();
  for (const r of roots) {
    const abs = expandHome(r);
    if (existsSync(abs)) {
      try {
        if (statSync(abs).isDirectory()) findSkillMds(abs, map);
      } catch {}
    }
  }
  return map;
}

export function buildSkillRootsCacheKey(roots) {
  if (!Array.isArray(roots) || roots.length === 0) return "<empty>";
  return roots
    .map((root) => expandHome(root))
    .filter(Boolean)
    .map((root) => resolve(root))
    .sort()
    .join("::");
}

// ---------- auth：Feishu SDK + app registration 授权 ----------

export function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  return null;
}

function formatError(error) {
  if (!error) return "unknown error";
  const parts = [];
  if (error?.name) parts.push(`name=${error.name}`);
  if (error?.message) parts.push(`message=${error.message}`);
  if (error?.cause) {
    if (typeof error.cause === "object") {
      const causeMessage = error.cause?.message || error.cause?.code || JSON.stringify(error.cause);
      parts.push(`cause=${causeMessage}`);
    } else {
      parts.push(`cause=${String(error.cause)}`);
    }
  }
  if (parts.length === 0) return String(error);
  return parts.join(" ");
}

function normalizeAccountId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed;
}

export function getAccountId(ctx) {
  const direct = normalizeAccountId(ctx?.accountId) || normalizeAccountId(ctx?.account) || normalizeAccountId(ctx?.channelAccountId) || null;
  if (direct) return direct;
  if (ctx?.sessionId && cachedAccountBySession.has(ctx.sessionId)) {
    return normalizeAccountId(cachedAccountBySession.get(ctx.sessionId));
  }
  if (ctx?.sessionKey && cachedAccountBySession.has(ctx.sessionKey)) {
    return normalizeAccountId(cachedAccountBySession.get(ctx.sessionKey));
  }
  fileLog(`getAccountId: MISS sessionId=${ctx?.sessionId || "<none>"} sessionKey=${ctx?.sessionKey || "<none>"} cacheSize=${cachedAccountBySession.size}`);
  return null;
}

function getProfileField(profile, candidates) {
  for (const key of candidates) {
    const value = profile?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstStringField(source, fields) {
  for (const field of fields) {
    const value = source?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function selectAuthedUserProfile(profiles, options = {}) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const accountId = options.accountId || null;
  const appId = options.appId || null;
  const normalized = profiles.map((profile) => ({
    profile,
    openId: getProfileField(profile, ["userOpenId", "user_open_id", "openId", "open_id"]),
    accountId: getProfileField(profile, ["accountId", "account_id", "profileId", "profile_id", "id"]),
    appId: getProfileField(profile, ["appId", "app_id", "clientId", "client_id"]),
  }));

  if (appId) {
    const byAppId = normalized.find((entry) => entry.openId && entry.appId === appId);
    if (byAppId) return byAppId;
  }
  if (accountId) {
    const byAccountId = normalized.find((entry) => entry.openId && entry.accountId === accountId);
    if (byAccountId) return byAccountId;
  }
  return normalized.find((entry) => entry.openId) || null;
}

export function getSkillAuthCacheKey(skillPath, ctx) {
  return `${getAccountId(ctx) || "unknown"}::${resolve(skillPath)}`;
}

export async function getAccountCredentials(ctx) {
  const cfg = apiConfigRef;
  if (!cfg) {
    throw new Error("feishu account unresolved: api.config unavailable");
  }
  const feishuCfg = cfg?.channels?.feishu || null;
  if (!feishuCfg || typeof feishuCfg !== "object") {
    throw new Error("feishu account unresolved: channels.feishu missing in api.config");
  }

  const accounts = feishuCfg.accounts && typeof feishuCfg.accounts === "object"
    ? feishuCfg.accounts
    : {};
  const requestedAccountId = getAccountId(ctx);
  const accountIds = Object.keys(accounts);

  let resolvedAccountId = requestedAccountId;
  let merged = {
    ...feishuCfg,
  };

  if (requestedAccountId && accounts[requestedAccountId]) {
    merged = { ...feishuCfg, ...accounts[requestedAccountId] };
  } else if (!requestedAccountId && accountIds.length === 1) {
    resolvedAccountId = accountIds[0];
    merged = { ...feishuCfg, ...accounts[resolvedAccountId] };
  } else if (!requestedAccountId && feishuCfg.appId && feishuCfg.appSecret) {
    resolvedAccountId = "default";
  } else if (requestedAccountId) {
    throw new Error(`feishu account unresolved: accountId=${requestedAccountId} not found among [${accountIds.join(", ")}]`);
  }

  if (!merged.appId || !merged.appSecret) {
    throw new Error(`feishu account unresolved: missing appId/appSecret for ${resolvedAccountId || "default"}`);
  }

  const userOAuthRedirectUri = firstStringField(ctx, ["userOAuthRedirectUri", "oauthRedirectUri", "redirectUri"])
    || firstStringField(merged, ["userOAuthRedirectUri", "oauthRedirectUri", "redirectUri"])
    || process.env.OPENCLAW_FEISHU_USER_OAUTH_REDIRECT_URI
    || null;

  return {
    accountId: resolvedAccountId || "default",
    appId: String(merged.appId),
    appSecret: String(merged.appSecret),
    brand: resolveFeishuBrand(merged.domain),
    domain: merged.domain ? String(merged.domain) : null,
    ...(userOAuthRedirectUri ? { userOAuthRedirectUri } : {}),
  };
}

export async function getAppId(ctx) {
  const credentials = await getAccountCredentials(ctx);
  return credentials.appId;
}

export async function getAppScopes(ctx) {
  const credentials = await getAccountCredentials(ctx);
  const aid = credentials.appId;
  fileLog(`getAppScopes: resolved appId=${aid || "<empty>"} accountId=${credentials.accountId}`);
  const cached = appScopesCache.get(aid);
  const now = Date.now();
  if (cached?.scopes && cached.expiresAt > now) {
    return cached.scopes;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const combinedPromise = callFeishuOpenApi(credentials, {
    method: "GET",
    path: `/open-apis/application/v6/applications/${aid}`,
    params: { lang: "zh_cn" },
  }).then((response) => {
    if (!response || response.code !== 0) {
      fileLog(`getAppScopes: API failed: ${response?.msg || response?.message || "unparseable"}`);
      return null;
    }
    const scopesArr = response?.data?.app?.scopes;
    if (!Array.isArray(scopesArr)) {
      return null;
    }
    const catalog = scopesArr
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        scope: item?.scope ? String(item.scope) : "",
        tokenTypes: Array.isArray(item?.token_types)
          ? [...new Set(item.token_types.map((t) => String(t)))]
          : [],
        level: Number.isFinite(Number(item?.level)) ? Number(item.level) : 0,
      }))
      .filter((entry) => entry.scope);
    const scopes = [...new Set(catalog.map((item) => item.scope).filter(Boolean))];
    if (!scopes) {
      appScopesCache.delete(aid);
      appScopeCatalogCache.delete(aid);
      return null;
    }
    appScopesCache.set(aid, {
      scopes,
      expiresAt: Date.now() + APP_SCOPES_CACHE_TTL_MS,
      promise: null,
    });
    appScopeCatalogCache.set(aid, {
      catalog,
      expiresAt: Date.now() + APP_SCOPES_CACHE_TTL_MS,
      promise: null,
    });
    return scopes;
  }).catch((error) => {
    fileLog(`getAppScopes: request failed: ${formatError(error)}`);
    appScopesCache.delete(aid);
    appScopeCatalogCache.delete(aid);
    return null;
  });

  appScopesCache.set(aid, { scopes: null, expiresAt: 0, promise: combinedPromise });
  return combinedPromise;
}

async function getAppScopeCatalog(ctx) {
  const credentials = await getAccountCredentials(ctx);
  const aid = credentials.appId;
  const cached = appScopeCatalogCache.get(aid);
  const now = Date.now();
  if (cached?.catalog && cached.expiresAt > now) {
    return cached.catalog;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const combinedPromise = callFeishuOpenApi(credentials, {
    method: "GET",
    path: `/open-apis/application/v6/applications/${aid}`,
    params: { lang: "zh_cn" },
  }).then((response) => {
    if (!response || response.code !== 0) {
      fileLog(`getAppScopeCatalog: API failed: ${response?.msg || response?.message || "unparseable"}`);
      return null;
    }
    const scopesArr = response?.data?.app?.scopes;
    if (!Array.isArray(scopesArr)) {
      return null;
    }
    const catalog = scopesArr
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        scope: item?.scope ? String(item.scope) : "",
        tokenTypes: Array.isArray(item?.token_types)
          ? [...new Set(item.token_types.map((t) => String(t)))]
          : [],
        level: Number.isFinite(Number(item?.level)) ? Number(item.level) : 0,
      }))
      .filter((entry) => entry.scope);
    appScopeCatalogCache.set(aid, {
      catalog,
      expiresAt: Date.now() + APP_SCOPES_CACHE_TTL_MS,
      promise: null,
    });
    appScopesCache.set(aid, {
      scopes: [...new Set(catalog.map((item) => item.scope).filter(Boolean))],
      expiresAt: Date.now() + APP_SCOPES_CACHE_TTL_MS,
      promise: null,
    });
    return catalog;
  }).catch((error) => {
    fileLog(`getAppScopeCatalog: request failed: ${formatError(error)}`);
    appScopeCatalogCache.delete(aid);
    return null;
  });

  appScopeCatalogCache.set(aid, { catalog: null, expiresAt: 0, promise: combinedPromise });
  return combinedPromise;
}

export async function checkApplicationAuthorization(scopes, identity, ctx) {
  const normalizedScopes = Array.isArray(scopes)
    ? [...new Set(scopes.map((s) => typeof s === "string" ? s.trim() : "").filter(Boolean))]
    : [];
  if (normalizedScopes.length === 0) {
    return { ok: true, missing: [], incompatible: [], granted: [], catalogUnavailable: false };
  }

  const requiredTokenType = identity === "app" ? "tenant" : "user";
  const catalog = await getAppScopeCatalog(ctx);
  if (!catalog) {
    fileLog(`checkApplicationAuthorization: getAppScopeCatalog failed, falling back to all missing identity=${identity}`);
    return {
      ok: false,
      missing: normalizedScopes,
      incompatible: [],
      granted: [],
      catalogUnavailable: true,
    };
  }
  const catalogMap = new Map(catalog.map((entry) => [entry.scope, entry]));
  const missing = [];
  const incompatible = [];
  const granted = [];
  for (const scope of normalizedScopes) {
    const entry = catalogMap.get(scope);
    if (!entry) {
      missing.push(scope);
      continue;
    }
    const tokenTypes = Array.isArray(entry.tokenTypes) ? entry.tokenTypes : [];
    if (!tokenTypes.includes(requiredTokenType)) {
      incompatible.push(scope);
      continue;
    }
    granted.push(scope);
  }
  fileLog(`checkApplicationAuthorization: identity=${identity} missing=${JSON.stringify(missing)} incompatible=${JSON.stringify(incompatible)} granted=${JSON.stringify(granted)}`);
  return {
    ok: missing.length === 0 && incompatible.length === 0,
    missing,
    incompatible,
    granted,
    catalogUnavailable: false,
  };
}

export async function checkScopes(scopes, ctx) {
  if (!scopes?.length) return { ok: true, missing: [], granted: [] };
  const appScopes = await getAppScopes(ctx);
  if (!appScopes) {
    fileLog(`checkScopes: getAppScopes failed, falling back to all missing`);
    return { ok: false, missing: scopes, granted: [] };
  }
  const appScopesSet = new Set(appScopes);
  const missing = scopes.filter((s) => !appScopesSet.has(s));
  const granted = scopes.filter((s) => appScopesSet.has(s));
  fileLog(`checkScopes: appScopes=${appScopes.length}, missing=${JSON.stringify(missing)}, granted=${JSON.stringify(granted)}`);
  return { ok: missing.length === 0, missing, granted };
}

function normalizeGrantedScopes(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        return normalizeGrantedScopes(JSON.parse(trimmed));
      } catch {}
    }
    return [...new Set(trimmed.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
  }
  return [];
}

function readScopesFromContainer(container) {
  if (!container || typeof container !== "object") return [];
  const fields = [
    "scopes",
    "scope",
    "grantedScopes",
    "granted_scopes",
    "oauthScopes",
    "oauth_scopes",
    "userScopes",
    "user_scopes",
    "authorizedScopes",
    "authorized_scopes",
  ];
  for (const field of fields) {
    const scopes = normalizeGrantedScopes(container[field]);
    if (scopes.length) return scopes;
  }
  return [];
}

function hasUserAccessToken(container) {
  return !!firstStringField(container, [
    "userAccessToken",
    "user_access_token",
    "accessToken",
    "access_token",
    "token",
  ]);
}

function normalizeExpiresAtMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1000000000000 ? numeric * 1000 : numeric;
}

function getUserTokenExpiredState(container) {
  if (!container || typeof container !== "object") return false;
  if (container.tokenExpired === true || container.token_expired === true || container.expired === true) return true;
  if (!hasUserAccessToken(container)) return false;
  const expiresAt = normalizeExpiresAtMs(
    container.expiresAt
      ?? container.expires_at
      ?? container.expireAt
      ?? container.expire_at
      ?? container.expireTime
      ?? container.expire_time
      ?? container.tokenExpiresAt
      ?? container.token_expires_at,
  );
  return expiresAt != null && expiresAt <= Date.now();
}

async function resolveGrantedUserScopes(ctx) {
  const profileCollections = [
    ["ctx.authProfiles", ctx?.authProfiles],
    ["ctx.authedUserProfiles", ctx?.authedUserProfiles],
    ["ctx.userProfiles", ctx?.userProfiles],
    ["ctx.profiles", ctx?.profiles],
    ["ctx.trace.authProfiles", ctx?.trace?.authProfiles],
    ["ctx.trace.authedUserProfiles", ctx?.trace?.authedUserProfiles],
    ["ctx.trace.userProfiles", ctx?.trace?.userProfiles],
    ["ctx.trace.profiles", ctx?.trace?.profiles],
  ];
  let appId = null;
  try {
    appId = (await getAccountCredentials(ctx)).appId;
  } catch {}
  const options = {
    accountId: getAccountId(ctx),
    appId,
  };
  for (const [label, profiles] of profileCollections) {
    if (!Array.isArray(profiles) || profiles.length === 0) continue;
    const matched = selectAuthedUserProfile(profiles, options);
    const scopes = readScopesFromContainer(matched?.profile);
    if (scopes.length) {
      return {
        scopes,
        source: label,
        tokenExpired: getUserTokenExpiredState(matched?.profile),
      };
    }
  }

  return { scopes: null, source: "unresolved" };
}

export async function checkUserAuthorization(scopes, ctx) {
  if (!scopes?.length) return { ok: true, missing: [], granted: [], source: "empty" };
  const resolved = await resolveGrantedUserScopes(ctx);
  if (!resolved?.scopes?.length) {
    fileLog(`checkUserAuthorization: no granted user scopes found in context, falling back to all missing (source=${resolved?.source || "unknown"})`);
    return { ok: false, missing: scopes, granted: [], source: resolved?.source || "unknown" };
  }
  if (resolved.tokenExpired) {
    fileLog(`checkUserAuthorization: source=${resolved.source} user token expired, falling back to all missing`);
    return { ok: false, missing: scopes, granted: [], source: resolved.source, reason: "user_token_expired" };
  }
  const grantedScopeSet = new Set(resolved.scopes);
  const missing = scopes.filter((scope) => !grantedScopeSet.has(scope));
  const granted = scopes.filter((scope) => grantedScopeSet.has(scope));
  fileLog(`checkUserAuthorization: source=${resolved.source} grantedScopes=${resolved.scopes.length} missing=${JSON.stringify(missing)} granted=${JSON.stringify(granted)}`);
  return { ok: missing.length === 0, missing, granted, source: resolved.source };
}

export async function checkUserAuthorizationByLarkCli(scopes, ctx, options = {}) {
  const normalizedScopes = Array.isArray(scopes)
    ? [...new Set(scopes.map((s) => typeof s === "string" ? s.trim() : "").filter(Boolean))]
    : [];
  if (normalizedScopes.length === 0) {
    return { ok: true, missing: [], source: "lark-cli" };
  }

  const adapter = options.adapter || createLarkCliAuthAdapter({
    execFile,
    spawn,
    ...(options.larkCliPath ? { cliPath: options.larkCliPath } : {}),
    log: fileLog,
  });
  const cap = await adapter.capabilityCheck();
  if (!cap?.ok) {
    fileLog(`checkUserAuthorizationByLarkCli: capability check failed`);
    return { ok: false, missing: normalizedScopes, source: "lark-cli", reason: "capability" };
  }
  try {
    const credentials = await getAccountCredentials(ctx);
    const bound = await adapter.bind({ appId: credentials.appId });
    if (!bound?.ok) {
      fileLog(`checkUserAuthorizationByLarkCli: bind failed`);
      return { ok: false, missing: normalizedScopes, source: "lark-cli", reason: "bind" };
    }
  } catch {
    return { ok: false, missing: normalizedScopes, source: "lark-cli", reason: "bind" };
  }

  const check = await adapter.check({ scopes: normalizedScopes });
  if (check?.ok) return { ok: true, missing: [], source: "lark-cli" };
  const missingScopes = Array.isArray(check?.missing) ? check.missing : normalizedScopes;
  return { ok: false, missing: missingScopes, source: "lark-cli" };
}

export async function startLogin(missing, ctx, options = {}) {
  if (!missing?.length) return { error: "no scopes" };
  try {
    const credentials = await getAccountCredentials(ctx);
    if (options.checkPhase === "user_grant") {
      if (options.userAuthProvider === "lark-cli") {
        const adapter = createLarkCliAuthAdapter({
          execFile,
          spawn,
          ...(options.larkCliPath ? { cliPath: options.larkCliPath } : {}),
          log: fileLog,
        });
        const cap = await adapter.capabilityCheck();
        if (!cap.ok) {
          throw new Error(`lark-cli capability check failed: ${cap.error || "unknown"}`);
        }
        const bind = await adapter.bind({ appId: credentials.appId });
        if (!bind.ok) {
          throw new Error(`lark-cli bind failed: ${bind.detail || bind.error || "unknown"}`);
        }
        const flow = await adapter.startDeviceFlow({ scopes: missing });
        if (!flow.ok) {
          throw new Error(`lark-cli login failed: ${flow.error || "unknown"}`);
        }
        return {
          verificationUrl: flow.verificationUrl,
          userCode: null,
          deviceCode: flow.deviceCode,
          expiresIn: flow.expiresIn,
          interval: null,
          provider: "lark-cli",
        };
      }
      const redirectUri = options.redirectUri || credentials.userOAuthRedirectUri;
      if (redirectUri) {
        return await beginUserOAuthFlow({
          appId: credentials.appId,
          brand: credentials.brand,
          redirectUri,
          scopes: missing,
          state: options.state || buildUserOAuthState(ctx, missing),
        });
      }
      fileLog("startLogin: context user grant has no redirect URI; falling back to scope grant flow");
    }
    return await beginScopeGrantFlow({
      appId: credentials.appId,
      brand: credentials.brand,
      scopes: missing,
      identity: options.identity || "user",
    });
  } catch (error) {
    fileLog(`startLogin: request failed: ${formatError(error)}`);
    return { error: String(error?.message || error) };
  }
}

function buildUserOAuthState(ctx, scopes) {
  const payload = {
    source: "openclaw-skill-runtime",
    accountId: getAccountId(ctx) || undefined,
    openId: getCachedSenderId(ctx) || inferSenderIdFromCtx(ctx) || undefined,
    sessionId: ctx?.sessionId || undefined,
    scopes: Array.isArray(scopes) ? scopes.slice().sort() : [],
    ts: Date.now(),
  };
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function getAuthedUser(ctx) {
  const openId = getCachedSenderId(ctx) || null;
  return openId ? { openId } : null;
}

export async function ensureFeishuRuntimeHealth() {
  if (runtimeHealthCache) return runtimeHealthCache;
  runtimeHealthCache = getAccountCredentials({})
    .then((credentials) => {
      const info = {
        ok: true,
        source: "config",
        command: "feishu-sdk",
        version: "node-sdk",
        recommendedVersion: "node-sdk",
        matchesRecommended: true,
        recoveryHint: null,
        accountId: credentials.accountId,
        appId: credentials.appId,
      };
      fileLog(`runtime: feishu sdk ready accountId=${credentials.accountId} appId=${credentials.appId}`);
      return info;
    })
    .catch((error) => {
      const info = {
        ok: false,
        source: "config",
        command: "feishu-sdk",
        version: null,
        recommendedVersion: "node-sdk",
        matchesRecommended: false,
        error: error?.message || String(error),
        recoveryHint: "请在 api.config.channels.feishu 或 channels.feishu.accounts 中配置可用的 appId/appSecret。",
      };
      fileLog(`runtime: feishu sdk unavailable error=${info.error}`);
      return info;
    });
  return runtimeHealthCache;
}

export function sidebarApplink(authUrl) {
  const q = encodeURIComponent(authUrl);
  return `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${q}`;
}

/** 按 skillName 去重的轮询定时器，防止同一技能创建多个轮询 */
const activePollingIntervals = new Map();

function resolveFeishuReceiveTarget({ openId, chatId, ctx }) {
  const normalizedOpenId = typeof openId === "string" && openId.trim() ? openId.trim() : null;
  const normalizedChatId = typeof chatId === "string" && chatId.trim() ? chatId.trim() : null;

  if (normalizedOpenId) return { receiveIdType: "open_id", receiveId: normalizedOpenId };
  if (normalizedChatId) return { receiveIdType: "chat_id", receiveId: normalizedChatId };

  const channelId = typeof ctx?.channelId === "string" ? ctx.channelId.trim() : null;
  if (channelId && /^ou_[A-Za-z0-9]/.test(channelId)) return { receiveIdType: "open_id", receiveId: channelId };
  if (channelId && /^oc_[A-Za-z0-9]/.test(channelId)) return { receiveIdType: "chat_id", receiveId: channelId };

  const ctxSenderId = typeof ctx?.senderId === "string" ? ctx.senderId.trim() : null;
  if (ctxSenderId && /^ou_[A-Za-z0-9]/.test(ctxSenderId)) return { receiveIdType: "open_id", receiveId: ctxSenderId };

  const ctxChatId = typeof ctx?.chatId === "string" ? ctx.chatId.trim() : null;
  if (ctxChatId && /^oc_[A-Za-z0-9]/.test(ctxChatId)) return { receiveIdType: "chat_id", receiveId: ctxChatId };

  return null;
}

async function sendInteractiveCard({ openId, chatId, card, timeoutMs = 20000, ctx = {} }) {
  const target = resolveFeishuReceiveTarget({ openId, chatId, ctx });
  if (!target) return { error: "no recipient" };

  if (target.receiveIdType === "open_id" && pluginApiRef?.tools?.feishu_im_user_message) {
    fileLog(`sendInteractiveCard: using plugin tool for openId=${target.receiveId}`);
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "send",
        receive_id: target.receiveId,
        receive_id_type: "open_id",
        msg_type: "interactive",
        content: JSON.stringify(card),
      });
      return {
        messageId: response?.data?.message_id || response?.message_id || response?.id || (response?.success ? "sent" : null),
      };
    } catch (error) {
      fileLog(`sendInteractiveCard: plugin tool failed: ${formatError(error)}`);
    }
  } else {
    fileLog(`sendInteractiveCard: using HTTP fallback receive_id_type=${target.receiveIdType} receive_id=${target.receiveId}`);
  }
  const credentials = await getAccountCredentials(ctx);
  try {
    fileLog(`sendInteractiveCard: HTTP accountId=${credentials.accountId} receive_id_type=${target.receiveIdType} receive_id=${target.receiveId}`);
    const response = await callFeishuOpenApi(credentials, {
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: target.receiveIdType },
      body: {
        receive_id: target.receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    return { messageId: response?.data?.message_id || null };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function sendAuthSuccessCard({ skillName, openId, chatId, accountId, ctx }) {
  const doneCard = {
    schema: "2.0",
    config: { wide_screen_mode: true, width_mode: "compact" },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "授权完成" },
      subtitle: { tag: "plain_text", content: `技能 “${skillName}” 已可使用` },
      icon: { ...LARK_AUTH_CARD_ICON },
    },
    body: {
      elements: [
        { tag: "markdown", content: `技能 **${skillName}** 的飞书权限已授权成功！现在可以正常使用啦 🦐` },
      ],
    },
  };
  return sendInteractiveCard({ openId, chatId, card: doneCard, timeoutMs: 10000, ctx: { ...(ctx || {}), accountId } });
}

export function startWaitForAuth({
  authTargetKey,
  skillName,
  deviceCode,
  missingKey,
  openId,
  scopes,
  ctx,
  identity = "user",
  checkPhase = "app_scope",
  userAuthProvider = "lark-cli",
  larkCliPath = null,
}) {
  if (!deviceCode) return;
  // 如果该技能已有轮询在跑，先清理旧的，避免重复
  const pollingKey = authTargetKey || skillName;
  const existing = activePollingIntervals.get(pollingKey);
  if (existing) {
    clearInterval(existing.interval);
    existing.completed = true;
    fileLog(`waitForAuth: replacing existing poll for "${pollingKey}"`);
  }

  fileLog(`waitForAuth: starting for "${skillName}" identity=${identity} phase=${checkPhase} provider=${userAuthProvider || "<default>"}`);
  const t0 = Date.now();
  // 轮询间隔 15 秒（用户手动授权通常需要更长时间，无需高频请求）
  const POLL_MS = 15000;
  // 最大等待 3 分钟，与发卡冷却时间一致
  const MAX_WAIT_MS = 180000;
  let interval = null;
  let completed = false;
  let backgroundWaitStarted = false;
  let adapter = null;

  // 注册到全局 map，供后续去重
  activePollingIntervals.set(pollingKey, { interval: null, completed: false, get completedRef() { return completed; } });

  const cleanup = () => {
    if (interval) { clearInterval(interval); interval = null; }
    completed = true;
    activePollingIntervals.delete(pollingKey);
  };

  const poll = async () => {
    if (completed) return;
    try {
      const elapsed = Date.now() - t0;
      if (elapsed > MAX_WAIT_MS) {
        fileLog(`waitForAuth: "${skillName}" timed out after ${Math.round(elapsed / 1000)}s`);
        cleanup();
        return;
      }

      let allGranted = false;
      if (checkPhase === "user_grant") {
        if (userAuthProvider === "lark-cli") {
          if (!adapter) {
            adapter = createLarkCliAuthAdapter({
              execFile,
              spawn,
              ...(larkCliPath ? { cliPath: larkCliPath } : {}),
              log: fileLog,
            });
          }
          if (!backgroundWaitStarted) {
            backgroundWaitStarted = true;
            adapter.waitForDeviceFlow({ deviceCode, timeoutMs: MAX_WAIT_MS }).catch(() => {});
          }
          const check = await adapter.check({ scopes });
          allGranted = !!check?.ok;
        } else {
          const check = await checkUserAuthorization(scopes, ctx);
          allGranted = !!check?.ok;
        }
      } else {
        const appScopes = await getAppScopes(ctx);
        if (appScopes) {
          const appScopesSet = new Set(appScopes);
          allGranted = scopes.every((s) => appScopesSet.has(s));
        }
      }
      if (allGranted) {
        cleanup();
        fileLog(`waitForAuth: "${skillName}" authorized! (${Math.round(elapsed / 1000)}s) identity=${identity} phase=${checkPhase}`);
        const sent = await sendAuthSuccessCard({ skillName, openId, accountId: ctx?.accountId || ctx?.account, ctx });
        if (!sent?.messageId && sent?.error) {
          fileLog(`waitForAuth: auth success card failed for "${skillName}": ${sent.error}`);
        }
        return;
      }
    } catch (error) {
      fileLog(`waitForAuth: poll failed for "${skillName}": ${error?.message || error}`);
    }
  };

  interval = setInterval(poll, POLL_MS);
  // 更新全局 map 中的 interval 引用（创建时 interval 为 null，需要回填）
  const entry = activePollingIntervals.get(pollingKey);
  if (entry) entry.interval = interval;
  poll();
}

export async function sendAuthCard({ skillName, missing, declaredScopes, verificationUrl, userCode, openId, chatId, accountId, identity = "user", checkPhase = "app_scope", ctx }) {
  // 用 sidebar-semi applink 包裹，在飞书内以侧边栏打开，不跳转系统浏览器
  const authUrl = sidebarApplink(verificationUrl);
  fileLog(`sendAuthCard: skill="${skillName}" identity=${identity} phase=${checkPhase} openId=${openId ? "<present>" : "<none>"} chatId=${chatId ? "<present>" : "<none>"} scopeCount=${Array.isArray(missing) ? missing.length : 0}`);
  const currentScopeCount = missing.length;
  const displayedScopes = Array.isArray(declaredScopes) && declaredScopes.length ? declaredScopes : missing;
  const declaredScopeCount = displayedScopes.length;
  const scopeLines = displayedScopes.map((s) => `• \`${s}\``).join("\n");

  const isUserGrant = checkPhase === "user_grant";
  const isAppScope = checkPhase === "app_scope";
  const isAppIdentity = identity === "app";
  const isUserIdentityAppScope = isAppScope && identity === "user";
  const headerTemplate = isUserGrant
    ? "orange"
    : isUserIdentityAppScope
      ? "purple"
      : "blue";
  const title = isUserGrant
    ? "飞书当前用户 OAuth 授权提醒"
    : isUserIdentityAppScope
      ? "飞书用户身份 API 权限开通提醒"
      : isAppIdentity
        ? "飞书应用身份 API 权限开通提醒"
        : "飞书 API 权限开通提醒";
  const targetLabel = isUserGrant
    ? "当前用户授权"
    : isUserIdentityAppScope
      ? "用户身份 API 权限"
      : isAppIdentity
        ? "应用身份 API 权限"
        : "飞书 API 权限";
  const actionText = isUserGrant ? "授权" : "开通";
  const subtitle = `技能 “${skillName}” 需要完成飞书权限处理`;
  const desc = `授权对象：**${targetLabel}**\n\n技能 **${skillName}** 共声明 **${declaredScopeCount}** 项飞书权限。当前需要先处理 **${currentScopeCount}** 项，点开下方抽屉可查看完整声明。`;
  const panelTitle = `**🔍 查看 Skill 声明权限（${declaredScopeCount} 项）**`;
  const buttonText = `🚀 前往${actionText}`;
  const hint = `<font color='grey'>📝 点击「前往${actionText}」后，按飞书页面提示完成操作，再回到当前会话重试。</font>`;

  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: headerTemplate,
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      icon: { ...LARK_AUTH_CARD_ICON },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: desc,
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          background_color: "grey-50",
          header: {
            title: { tag: "markdown", content: panelTitle },
            vertical_align: "center",
            icon_position: "right",
            icon_expanded_angle: -180,
          },
          elements: [
            { tag: "markdown", content: scopeLines },
          ],
        },
        { tag: "hr" },
        {
          tag: "button",
          text: { tag: "plain_text", content: buttonText },
          type: "primary",
          width: "fill",
          size: "medium",
          behaviors: [{ type: "open_url", default_url: authUrl }],
        },
        {
          tag: "markdown",
          content: hint,
        }
      ],
    },
  };
  return sendInteractiveCard({ openId, chatId, card, timeoutMs: 20000, ctx: { ...(ctx || {}), accountId } });
}
