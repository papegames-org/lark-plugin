// utils.js — OpenClaw Skill Runtime 工具函数集
// 包含：日志、workspace 查找、skill-map 构建、auth 操作等（frontmatter 解析已移至 parse-meta.js）
// ============================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import {
  beginScopeGrantFlow,
  callFeishuOpenApi,
  resolveFeishuBrand,
} from "./feishu-runtime.js";

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
const LARK_AUTH_CARD_FOOTER_IMAGE_KEY =
  "img_v3_0013l_5b29ba19-9327-4eed-b5b9-3cd7f940494g";
const LARK_AUTH_CARD_HEADER_TAGS = [
  {
    tag: "text_tag",
    text: { tag: "plain_text", content: "Paper" },
    color: "red",
  },
];

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
}

// ---------- 日志 ----------

export function fileLog(msg) {
  console.log(`[openclaw-skill-runtime] ${new Date().toISOString()} ${msg}`);
}

export function logCtxSnapshotOnce(ctx) {
  if (!ctx || ctx.__larkScopeCtxLogged) return;
  try {
    Object.defineProperty(ctx, "__larkScopeCtxLogged", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    ctx.__larkScopeCtxLogged = true;
  }
  fileLog(
    `ctx snapshot=${JSON.stringify({
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
    })}`,
  );
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
  fileLog(
    `workspace: no ctx.workspaceDir and no cache for agentId=${ctx?.agentId || "<empty>"} — returning null`,
  );
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
  const roots = [join(homedir(), ".agents", "skills")];
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
  try {
    return JSON.parse(text);
  } catch {}
  const s = text.indexOf("{"),
    e = text.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      return JSON.parse(text.slice(s, e + 1));
    } catch {}
  }
  return null;
}

function formatFeishuApiResponseError(response) {
  if (!response) return "empty response";
  const code =
    response?.code ?? response?.error?.code ?? response?.status_code ?? null;
  const message =
    response?.msg ||
    response?.message ||
    response?.error?.message ||
    response?.error_description ||
    null;
  const requestId =
    response?.request_id || response?.RequestId || response?.requestId || null;
  const details = [];
  if (code !== null && code !== undefined) details.push(`code=${code}`);
  if (message) details.push(`msg=${message}`);
  if (requestId) details.push(`request_id=${requestId}`);
  if (details.length) return details.join(" ");
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

function formatError(error) {
  if (!error) return "unknown error";
  const parts = [];
  if (error?.name) parts.push(`name=${error.name}`);
  if (error?.message) parts.push(`message=${error.message}`);
  if (error?.cause) {
    if (typeof error.cause === "object") {
      const causeMessage =
        error.cause?.message ||
        error.cause?.code ||
        JSON.stringify(error.cause);
      parts.push(`cause=${causeMessage}`);
    } else {
      parts.push(`cause=${String(error.cause)}`);
    }
  }
  if (parts.length === 0) return String(error);
  return parts.join(" ");
}

let larkCliCommandRunnerForTest = null;
let larkCliDeviceWaitSpawnerForTest = null;

export function setLarkCliCommandRunnerForTest(runner) {
  larkCliCommandRunnerForTest = typeof runner === "function" ? runner : null;
}

export function setLarkCliDeviceWaitSpawnerForTest(spawner) {
  larkCliDeviceWaitSpawnerForTest = typeof spawner === "function" ? spawner : null;
}

function getLarkCliBaseArgs() {
  const profile = String(
    process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE ||
      process.env.LARK_PROFILE_NAME ||
      "",
  ).trim();
  return profile ? ["--profile", profile] : [];
}

function runLarkCli(args, options = {}) {
  const fullArgs = [...getLarkCliBaseArgs(), ...args];
  if (larkCliCommandRunnerForTest) {
    return Promise.resolve(larkCliCommandRunnerForTest(fullArgs, options));
  }
  return new Promise((resolveResult) => {
    execFile(
      "lark-cli",
      fullArgs,
      {
        timeout: options.timeoutMs || 30000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout = "", stderr = "") => {
        resolveResult({
          ok: !error,
          code: error?.code ?? 0,
          signal: error?.signal || null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error || null,
        });
      },
    );
  });
}

function extractJsonPayload(...texts) {
  const candidates = [];
  for (const text of texts) {
    const raw = String(text || "").trim();
    if (!raw) continue;
    candidates.push(raw);
    candidates.push(...raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse());
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const parsed = parseJsonLoose(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

function summarizeCommandResult(result) {
  const detail = [result?.stdout, result?.stderr, result?.error?.message]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n");
  return detail || `exit=${result?.code ?? "unknown"}`;
}

function spawnLarkCliDeviceWait(deviceCode) {
  const code = String(deviceCode || "").trim();
  if (!code) return { error: "no deviceCode" };
  const fullArgs = [...getLarkCliBaseArgs(), "auth", "login", "--device-code", code];
  if (larkCliDeviceWaitSpawnerForTest) {
    return larkCliDeviceWaitSpawnerForTest(fullArgs) || { started: true };
  }
  try {
    const child = spawn("lark-cli", fullArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { started: true, pid: child.pid || null };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function checkUserGrantViaLarkCli(scopes) {
  const result = await runLarkCli(
    ["auth", "check", "--json", "--scope", scopes.join(" ")],
    { timeoutMs: 30000 },
  );
  const payload = extractJsonPayload(result.stdout, result.stderr);
  if (payload) {
    const normalized = normalizeGrantCheckResult(payload, scopes);
    if (normalized) return { ...normalized, source: "lark-cli" };
  }
  return {
    ok: false,
    missing: scopes,
    granted: [],
    unavailable: true,
    source: "lark-cli",
    reason: summarizeCommandResult(result),
  };
}

async function startUserGrantLogin(scopes) {
  const result = await runLarkCli(
    ["auth", "login", "--scope", scopes.join(" "), "--no-wait", "--json"],
    { timeoutMs: 30000 },
  );
  const payload = extractJsonPayload(result.stdout, result.stderr);
  const verificationUrl = String(
    payload?.verification_url ||
      payload?.verificationUrl ||
      payload?.verification_uri_complete ||
      payload?.verificationUriComplete ||
      payload?.url ||
      "",
  ).trim();
  const deviceCode = String(payload?.device_code || payload?.deviceCode || "").trim();
  if (!verificationUrl || !deviceCode) {
    return { error: summarizeCommandResult(result) };
  }
  const waiter = spawnLarkCliDeviceWait(deviceCode);
  if (waiter?.error) {
    fileLog(`startLogin: lark-cli device waiter failed: ${waiter.error}`);
  } else {
    fileLog(`startLogin: lark-cli device waiter started pid=${waiter?.pid || "unknown"}`);
  }
  return {
    verificationUrl,
    userCode: payload?.user_code || payload?.userCode || null,
    deviceCode,
    expiresIn: Number(payload?.expires_in || payload?.expiresIn || 600) || 600,
    interval: Number(payload?.interval || 5) || 5,
    provider: "lark-cli",
  };
}
export function normalizeAuthIdentity(identity) {
  const raw = String(identity || "user").trim().toLowerCase();
  if (["app", "application", "tenant", "bot", "application_identity"].includes(raw)) return "app";
  return "user";
}

function normalizeScopeIdentity(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (["user", "user_identity", "user_access_token", "用户身份", "用户"].includes(raw)) return "user";
  if (["app", "application", "tenant", "bot", "app_identity", "tenant_access_token", "应用身份", "应用"].includes(raw)) return "app";
  if (raw.includes("user") || raw.includes("用户")) return "user";
  if (raw.includes("app") || raw.includes("tenant") || raw.includes("bot") || raw.includes("应用")) return "app";
  return null;
}

export function normalizeAppScopeEntries(scopesArr) {
  if (!Array.isArray(scopesArr)) return [];
  const entries = [];
  for (const item of scopesArr) {
    if (!item || typeof item !== "object") continue;
    const scope = typeof item.scope === "string" ? item.scope.trim() : "";
    if (!scope) continue;
    const identity = [
      item.identity,
      item.identity_type,
      item.identityType,
      item.permission_type,
      item.permissionType,
      item.scope_type,
      item.scopeType,
      item.grant_type,
      item.grantType,
      item.auth_type,
      item.authType,
      item.type,
    ].map(normalizeScopeIdentity).find(Boolean) || null;
    entries.push({ scope, identity, raw: item });
  }
  return entries;
}

function hasIdentityMetadata(entries) {
  return entries.some((entry) => entry.identity === "user" || entry.identity === "app");
}
function normalizeAccountId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed;
}

export function getAccountId(ctx) {
  const direct =
    normalizeAccountId(ctx?.accountId) ||
    normalizeAccountId(ctx?.account) ||
    normalizeAccountId(ctx?.channelAccountId) ||
    null;
  if (direct) return direct;
  if (ctx?.sessionId && cachedAccountBySession.has(ctx.sessionId)) {
    return normalizeAccountId(cachedAccountBySession.get(ctx.sessionId));
  }
  if (ctx?.sessionKey && cachedAccountBySession.has(ctx.sessionKey)) {
    return normalizeAccountId(cachedAccountBySession.get(ctx.sessionKey));
  }
  fileLog(
    `getAccountId: MISS sessionId=${ctx?.sessionId || "<none>"} sessionKey=${ctx?.sessionKey || "<none>"} cacheSize=${cachedAccountBySession.size}`,
  );
  return null;
}

function getProfileField(profile, candidates) {
  for (const key of candidates) {
    const value = profile?.[key];
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
    openId: getProfileField(profile, [
      "userOpenId",
      "user_open_id",
      "openId",
      "open_id",
    ]),
    accountId: getProfileField(profile, [
      "accountId",
      "account_id",
      "profileId",
      "profile_id",
      "id",
    ]),
    appId: getProfileField(profile, [
      "appId",
      "app_id",
      "clientId",
      "client_id",
    ]),
  }));

  if (appId) {
    const byAppId = normalized.find(
      (entry) => entry.openId && entry.appId === appId,
    );
    if (byAppId) return byAppId;
  }
  if (accountId) {
    const byAccountId = normalized.find(
      (entry) => entry.openId && entry.accountId === accountId,
    );
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
    throw new Error(
      "feishu account unresolved: channels.feishu missing in api.config",
    );
  }

  const accounts =
    feishuCfg.accounts && typeof feishuCfg.accounts === "object"
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
    throw new Error(
      `feishu account unresolved: accountId=${requestedAccountId} not found among [${accountIds.join(", ")}]`,
    );
  }

  if (!merged.appId || !merged.appSecret) {
    throw new Error(
      `feishu account unresolved: missing appId/appSecret for ${resolvedAccountId || "default"}`,
    );
  }

  return {
    accountId: resolvedAccountId || "default",
    appId: String(merged.appId),
    appSecret: String(merged.appSecret),
    brand: resolveFeishuBrand(merged.domain),
    domain: merged.domain ? String(merged.domain) : null,
  };
}

export async function getAppId(ctx) {
  const credentials = await getAccountCredentials(ctx);
  return credentials.appId;
}

export async function getAppScopeEntries(ctx) {
  const credentials = await getAccountCredentials(ctx);
  const aid = credentials.appId;
  fileLog(
    `getAppScopes: resolved appId=${aid || "<empty>"} accountId=${credentials.accountId}`,
  );
  const cached = appScopesCache.get(aid);
  const now = Date.now();
  if (cached?.entries && cached.expiresAt > now) {
    return cached.entries;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const combinedPromise = callFeishuOpenApi(credentials, {
    method: "GET",
    path: `/open-apis/application/v6/applications/${aid}`,
    params: { lang: "zh_cn" },
  })
    .then((response) => {
      if (!response || response.code !== 0) {
        fileLog(
          `getAppScopes: API failed: ${response?.msg || response?.message || "unparseable"}`,
        );
        return null;
      }
      const scopesArr = response?.data?.app?.scopes;
      if (!Array.isArray(scopesArr)) {
        return null;
      }
      const entries = normalizeAppScopeEntries(scopesArr);
      appScopesCache.set(aid, {
        entries,
        expiresAt: Date.now() + APP_SCOPES_CACHE_TTL_MS,
        promise: null,
      });
      return entries;
    })
    .catch((error) => {
      fileLog(`getAppScopes: request failed: ${formatError(error)}`);
      appScopesCache.delete(aid);
      return null;
    });

  appScopesCache.set(aid, {
    entries: null,
    expiresAt: 0,
    promise: combinedPromise,
  });
  return combinedPromise;
}

export async function getAppScopes(ctx) {
  const entries = await getAppScopeEntries(ctx);
  if (!entries) return null;
  return [...new Set(entries.map((entry) => entry.scope).filter(Boolean))];
}

export async function checkScopes(scopes, ctx, options = {}) {
  if (!scopes?.length) return { ok: true, missing: [], granted: [], identity: normalizeAuthIdentity(options.identity) };
  const identity = normalizeAuthIdentity(options.identity);
  const appScopeEntries = await getAppScopeEntries(ctx);
  if (!appScopeEntries) {
    fileLog(`checkScopes: getAppScopes failed, falling back to all missing`);
    return { ok: false, missing: scopes, granted: [], identity };
  }

  const identityAware = hasIdentityMetadata(appScopeEntries);
  const legacyScopeSet = new Set(appScopeEntries.map((entry) => entry.scope));
  const granted = [];
  const missing = [];

  for (const scope of scopes) {
    const hasScope = identityAware
      ? appScopeEntries.some((entry) => entry.scope === scope && entry.identity === identity)
      : legacyScopeSet.has(scope);
    if (hasScope) granted.push(scope);
    else missing.push(scope);
  }

  if (!identityAware) {
    fileLog(`checkScopes: scope identity metadata unavailable; using legacy scope-string match for identity=${identity}`);
  }
  fileLog(
    `checkScopes: appScopes=${appScopeEntries.length}, identity=${identity}, identityAware=${identityAware}, missing=${JSON.stringify(missing)}, granted=${JSON.stringify(granted)}`,
  );
  return { ok: missing.length === 0, missing, granted, identity, identityAware };
}
export async function startLogin(missing, ctx, options = {}) {
  if (!missing?.length) return { error: "no scopes" };
  try {
    const authReason = String(options.authReason || "app_scope").trim();
    if (authReason === "user_grant") {
      return await startUserGrantLogin(missing);
    }
    const credentials = await getAccountCredentials(ctx);
    return await beginScopeGrantFlow({
      appId: credentials.appId,
      brand: credentials.brand,
      scopes: missing,
      identity: normalizeAuthIdentity(options.identity),
    });
  } catch (error) {
    fileLog(`startLogin: request failed: ${formatError(error)}`);
    return { error: String(error?.message || error) };
  }
}

export async function getAuthedUser(ctx) {
  const openId = getCachedSenderId(ctx) || null;
  return openId ? { openId } : null;
}
function normalizeGrantCheckResult(response, requestedScopes) {
  if (!response) return null;
  const source = response.data && typeof response.data === "object" ? response.data : response;
  const grantedScopes = source.grantedScopes || source.granted_scopes || source.scopes || source.scope || [];
  const missingScopes = source.missingScopes || source.missing_scopes || source.missing || [];
  const granted = Array.isArray(grantedScopes)
    ? grantedScopes.map(String)
    : String(grantedScopes || "").split(/[\s,]+/u).filter(Boolean);
  const explicitMissing = Array.isArray(missingScopes)
    ? missingScopes.map(String)
    : String(missingScopes || "").split(/[\s,]+/u).filter(Boolean);
  const grantedSet = new Set(granted);
  const missing = explicitMissing.length
    ? explicitMissing
    : requestedScopes.filter((scope) => !grantedSet.has(scope));
  const ok = source.ok === true || source.authorized === true || source.granted === true || missing.length === 0;
  return { ok, granted: requestedScopes.filter((scope) => !missing.includes(scope)), missing };
}

export async function checkUserGrant(openId, scopes, ctx) {
  if (!scopes?.length) return { ok: true, missing: [], granted: [] };
  if (!openId) return { ok: false, missing: scopes, granted: [], unavailable: true, reason: "no openId" };
  const tools = pluginApiRef?.tools || {};
  const checker =
    tools.openclaw_lark_check_user_grant ||
    tools.feishu_auth_check_user_grant ||
    tools.lark_auth_check_user_grant ||
    null;
  if (!checker) {
    return await checkUserGrantViaLarkCli(scopes);
  }
  try {
    const appId = await getAppId(ctx).catch(() => null);
    const response = await checker({
      openId,
      scopes,
      accountId: getAccountId(ctx),
      appId,
    });
    const normalized = normalizeGrantCheckResult(response, scopes);
    if (normalized) return normalized;
    fileLog(`checkUserGrant: checker response unparseable; falling back to lark-cli`);
    return await checkUserGrantViaLarkCli(scopes);
  } catch (error) {
    fileLog(`checkUserGrant: failed: ${formatError(error)}; falling back to lark-cli`);
    return await checkUserGrantViaLarkCli(scopes);
  }
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
      fileLog(
        `runtime: feishu sdk ready accountId=${credentials.accountId} appId=${credentials.appId}`,
      );
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
        recoveryHint:
          "请在 api.config.channels.feishu 或 channels.feishu.accounts 中配置可用的 appId/appSecret。",
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

async function sendInteractiveCard(openId, card, timeoutMs = 20000, ctx = {}) {
  if (!openId) return { error: "no openId" };
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    fileLog(`sendInteractiveCard: using plugin tool for openId=${openId}`);
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "send",
        receive_id: openId,
        receive_id_type: "open_id",
        msg_type: "interactive",
        content: JSON.stringify(card),
      });
      const messageId =
        response?.data?.message_id ||
        response?.message_id ||
        response?.id ||
        (response?.success ? "sent" : null);
      if (messageId) return { messageId };
      return { error: formatFeishuApiResponseError(response) };
    } catch (error) {
      fileLog(`sendInteractiveCard: plugin tool failed: ${formatError(error)}`);
    }
  } else {
    fileLog(
      `sendInteractiveCard: plugin tool unavailable, falling back to HTTP openId=${openId}`,
    );
  }
  const credentials = await getAccountCredentials(ctx);
  try {
    fileLog(
      `sendInteractiveCard: using HTTP fallback accountId=${credentials.accountId} openId=${openId}`,
    );
    const response = await callFeishuOpenApi(credentials, {
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: "open_id" },
      body: {
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    const messageId = response?.data?.message_id || null;
    if (messageId) return { messageId };
    return { error: formatFeishuApiResponseError(response) };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function sendAuthSuccessCard({ skillName, openId, accountId }) {
  const doneCard = {
    schema: "2.0",
    config: { wide_screen_mode: true, width_mode: "compact" },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "授权完成" },
      subtitle: { tag: "plain_text", content: `技能 “${skillName}” 已可使用` },
      text_tag_list: LARK_AUTH_CARD_HEADER_TAGS,
      icon: { tag: "standard_icon", token: "check_outlined" },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `技能 **${skillName}** 的飞书权限已授权成功！现在可以正常使用啦 🦐`,
        },
      ],
    },
  };
  return sendInteractiveCard(openId, doneCard, 10000, { accountId });
}

export function startWaitForAuth({
  authTargetKey,
  skillName,
  deviceCode,
  missingKey,
  openId,
  scopes,
  identity = "user",
  authReason = "app_scope",
  ctx,
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

  fileLog(
    `waitForAuth: starting for "${skillName}" deviceCode=${deviceCode.slice(0, 12)}...`,
  );
  const t0 = Date.now();
  // 轮询间隔 15 秒（用户手动授权通常需要更长时间，无需高频请求）
  const POLL_MS = 15000;
  // 最大等待 3 分钟，与发卡冷却时间一致
  const MAX_WAIT_MS = 180000;
  let interval = null;
  let completed = false;

  // 注册到全局 map，供后续去重
  activePollingIntervals.set(pollingKey, {
    interval: null,
    completed: false,
    get completedRef() {
      return completed;
    },
  });

  const cleanup = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    completed = true;
    activePollingIntervals.delete(pollingKey);
  };

  const poll = async () => {
    if (completed) return;
    try {
      const elapsed = Date.now() - t0;
      if (elapsed > MAX_WAIT_MS) {
        fileLog(
          `waitForAuth: "${skillName}" timed out after ${Math.round(elapsed / 1000)}s`,
        );
        cleanup();
        return;
      }

      const normalizedIdentity = normalizeAuthIdentity(identity);
      const check = authReason === "user_grant"
        ? await checkUserGrant(openId, scopes, ctx)
        : await checkScopes(scopes, ctx, { identity: normalizedIdentity });
      if (check?.ok) {
        cleanup();
        fileLog(
          `waitForAuth: "${skillName}" authorized! identity=${normalizedIdentity} authReason=${authReason} (${Math.round(elapsed / 1000)}s)`,
        );
        if (openId) {
          const sent = await sendAuthSuccessCard({
            skillName,
            openId,
            accountId: ctx?.accountId || ctx?.account,
          });
          if (!sent?.messageId && sent?.error) {
            fileLog(
              `waitForAuth: auth success card failed for "${skillName}": ${sent.error}`,
            );
          }
        }
        return;
      }
    } catch (error) {
      fileLog(
        `waitForAuth: poll failed for "${skillName}": ${error?.message || error}`,
      );
    }
  };

  interval = setInterval(poll, POLL_MS);
  // 更新全局 map 中的 interval 引用（创建时 interval 为 null，需要回填）
  const entry = activePollingIntervals.get(pollingKey);
  if (entry) entry.interval = interval;
  poll();
}

export async function sendAuthCard({
  skillName,
  missing,
  verificationUrl,
  userCode,
  openId,
  accountId,
  identity = "user",
  authReason = "app_scope",
}) {
  if (!openId) return { error: "no openId" };
  // 用 sidebar-semi applink 包裹，在飞书内以侧边栏打开，不跳转系统浏览器
  const authUrl = sidebarApplink(verificationUrl);
  fileLog(
    `sendAuthCard: skill="${skillName}" authUrl=${authUrl || "<EMPTY!>"} userCode=${userCode || "<none>"} openId=${openId}`,
  );
  const scopeCount = missing.length;
  const scopeLines = missing.map((s) => `• \`${s}\``).join("\n");
  const normalizedIdentity = normalizeAuthIdentity(identity);
  const isUserGrant = authReason === "user_grant";
  const authTitle = isUserGrant ? "飞书用户授权提醒" : "飞书应用权限开通提醒";
  const authSubtitle = isUserGrant
    ? `技能 “${skillName}” 需要你授权用户身份`
    : `技能 “${skillName}” 需要开通${normalizedIdentity === "user" ? "用户身份" : "应用身份"}权限`;
  const authIntro = isUserGrant
    ? `技能需要以你的用户身份访问 **${scopeCount}** 项飞书权限，目前你还没有完成用户授权。`
    : `技能需要应用先开通 **${scopeCount}** 项飞书${normalizedIdentity === "user" ? "用户身份" : "应用身份"}权限。`;
  const scopePanelTitle = isUserGrant ? "查看待授权权限" : "查看待开通权限";
  const buttonText = isUserGrant ? "🚀 前往用户授权" : "🚀 前往开通权限";
  const footerHint = isUserGrant
    ? "<font color='grey'>📝 点「前往用户授权」完成授权</font>"
    : "<font color='grey'>📝 点「前往开通权限」完成应用权限开通</font>";
  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: authTitle },
      subtitle: {
        tag: "plain_text",
        content: authSubtitle,
      },
      text_tag_list: LARK_AUTH_CARD_HEADER_TAGS,
      icon: { tag: "standard_icon", token: "safe_outlined" },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `${authIntro} 点开下方抽屉可查看具体权限。`,
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          background_color: "grey-50",
          header: {
            title: {
              tag: "markdown",
              content: `**🔍 ${scopePanelTitle}（${scopeCount} 项）**`,
            },
            vertical_align: "center",
            icon_position: "right",
            icon_expanded_angle: -180,
          },
          elements: [{ tag: "markdown", content: scopeLines }],
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
          tag: "column_set",
          flex_mode: "none",
          background_style: "default",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [
                {
                  tag: "markdown",
                  content: footerHint,
                },
              ],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: [
                {
                  tag: "img",
                  img_key: LARK_AUTH_CARD_FOOTER_IMAGE_KEY,
                  alt: { tag: "plain_text", content: "Paper" },
                  scale_type: "crop_center",
                  size: "80px 24px",
                  transparent: true,
                  preview: false,
                  margin: "0 0 0 8px",
                },
              ],
            },
          ],
        },
      ],
    },
  };
  return sendInteractiveCard(openId, card, 20000, { accountId });
}
