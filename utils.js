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
  larkCliProfileByAppId.clear();
}

// ---------- 日志 ----------

export function fileLog(msg) {
  const redacted = String(msg)
    .replace(/(["'](?:auth[_-]?url|verification[_-]?(?:url|uri(?:[_-]?complete)?)|user[_-]?code|device[_-]?code|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|app[_-]?secret|receive[_-]?id|open[_-]?id|sender[_-]?id)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/giu, "$1\"<redacted>\"")
    .replace(/\b(auth[_-]?url|verification[_-]?(?:url|uri(?:[_-]?complete)?)|user[_-]?code|device[_-]?code|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|app[_-]?secret|receive[_-]?id|open[_-]?id|sender[_-]?id)=\S+/giu, "$1=<redacted>")
    .replace(/https?:\/\/[^\s"']+/giu, "<redacted>")
    .replace(/\b(?:ou|oc)_[A-Za-z0-9_-]+\b/gu, "<redacted>");
  console.log(`[openclaw-skill-runtime] ${new Date().toISOString()} ${redacted}`);
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
    ctx?.sender?.sender_id?.open_id,
    ctx?.sender?.senderId?.openId,
    ctx?.sender?.open_id,
    ctx?.channelId,
  ];
  for (const value of candidates) {
    const target = normalizeAuthCardTarget(value);
    if (target?.receiveIdType === "open_id") return target.receiveId;
  }
  return null;
}

function normalizeAuthCardTarget(value) {
  let normalized = String(value || "").trim();
  if (!normalized) return null;
  while (/^(?:feishu|lark):/i.test(normalized)) {
    normalized = normalized.replace(/^(?:feishu|lark):/i, "").trim();
  }
  normalized = normalized.replace(/^(?:chat|chat_id|group|channel|open_id|user|dm|p2p):/i, "").trim();
  normalized = normalized.split(/:(?:topic|sender):/i, 1)[0].trim();
  if (/^(?:ou_|on_)[A-Za-z0-9]/.test(normalized)) {
    return { receiveId: normalized, receiveIdType: "open_id" };
  }
  if (/^oc_[A-Za-z0-9]/.test(normalized)) {
    return { receiveId: normalized, receiveIdType: "chat_id" };
  }
  return null;
}

export function resolveAuthCardRecipient(ctx = {}) {
  const openIdCandidates = [
    ctx?.senderId,
    ctx?.senderOpenId,
    ctx?.openId,
    ctx?.sender?.sender_id?.open_id,
    ctx?.sender?.senderId?.openId,
    ctx?.sender?.open_id,
    ctx?.sender?.id,
    process.env.OPENCLAW_SENDER_ID,
    process.env.SENDER_ID,
  ];
  for (const value of openIdCandidates) {
    const target = normalizeAuthCardTarget(value);
    if (target?.receiveIdType === "open_id") return target;
  }
  const cached = getCachedSenderId(ctx);
  if (cached) return { receiveId: cached, receiveIdType: "open_id" };

  const chatIdCandidates = [
    ctx?.chatId,
    ctx?.chat?.id,
    ctx?.chat_id,
    ctx?.channelId,
    process.env.OPENCLAW_CHAT_ID,
    process.env.OPENCLAW_INBOUND_CHAT_ID,
    process.env.CHAT_ID,
  ];
  for (const value of chatIdCandidates) {
    const target = normalizeAuthCardTarget(value);
    if (target?.receiveIdType === "chat_id") return target;
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

function isFeishuMutationSuccessful(response) {
  const code = response?.code;
  // Feishu OpenAPI always supplies code. When it is present, it must win over
  // any partial data object returned alongside an error response.
  if (code !== undefined && code !== null) return Number(code) === 0;
  // The OpenClaw message tool may omit code and only expose a success flag or
  // result data, so retain that compatibility for code-less tool responses.
  return response?.success === true || Boolean(response?.data);
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
const larkCliProfileByAppId = new Map();

export function setLarkCliCommandRunnerForTest(runner) {
  larkCliCommandRunnerForTest = typeof runner === "function" ? runner : null;
}

export function setLarkCliDeviceWaitSpawnerForTest(spawner) {
  larkCliDeviceWaitSpawnerForTest = typeof spawner === "function" ? spawner : null;
}

function getConfiguredLarkCliProfile() {
  return String(
    process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE ||
      process.env.LARK_PROFILE_NAME ||
      "",
  ).trim();
}

function getLarkCliBaseArgs(profileOverride = undefined) {
  const profile = profileOverride === undefined
    ? getConfiguredLarkCliProfile()
    : String(profileOverride || "").trim();
  return profile ? ["--profile", profile] : [];
}

function runLarkCli(args, options = {}) {
  const fullArgs = [...getLarkCliBaseArgs(options.profile), ...args];
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

const LARK_CLI_REQUIRED_MESSAGE = "lark-cli is required for identity=user authorization. Install @larksuite/cli, ensure the gateway PATH can find lark-cli, run `lark-cli config bind --source openclaw --identity user-default`, then restart gateway.";
const LARK_CLI_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

function isLarkCliMissingResult(result) {
  const parts = [
    result?.code,
    result?.error?.code,
    result?.error?.message,
    result?.stderr,
    result?.stdout,
  ].map((part) => String(part || ""));
  return parts.some((part) => /\bENOENT\b|not found|command not found/i.test(part));
}

async function checkLarkCliRuntimeReady(profile = undefined) {
  const result = await runLarkCli(["--version"], { timeoutMs: 10000, profile });
  if (result?.ok || (result?.code === 0 && !result?.error)) {
    return { ok: true, version: String(result.stdout || result.stderr || "").trim() };
  }
  const detail = summarizeCommandResult(result);
  const error = isLarkCliMissingResult(result)
    ? `lark-cli not found in gateway PATH. ${LARK_CLI_REQUIRED_MESSAGE}`
    : `lark-cli runtime check failed: ${detail}. ${LARK_CLI_REQUIRED_MESSAGE}`;
  return { ok: false, error, detail };
}

function extractJsonArray(...texts) {
  for (const text of texts) {
    const raw = String(text || "").trim();
    if (!raw) continue;
    const candidates = [raw, ...raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse()];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.profiles)) return parsed.profiles;
        if (Array.isArray(parsed?.data?.profiles)) return parsed.data.profiles;
      } catch {}
    }
  }
  return null;
}

async function resolveLarkCliProfile(ctx = {}) {
  const configured = getConfiguredLarkCliProfile();
  if (configured) return { resolved: true, profile: configured, source: "env" };

  const appId = await getAppId(ctx).catch(() => null);
  if (!appId) return { resolved: true, profile: null, source: "default" };
  const cached = larkCliProfileByAppId.get(appId);
  if (cached && (Date.now() - cached.resolvedAtMs) < LARK_CLI_PROFILE_CACHE_TTL_MS) {
    return { resolved: true, profile: cached.profile, source: "cache" };
  }

  const listed = await runLarkCli(["profile", "list"], { timeoutMs: 10000, profile: null });
  const profiles = extractJsonArray(listed.stdout, listed.stderr);
  if (!listed?.ok && !(listed?.code === 0 && !listed?.error)) {
    return { error: `lark-cli profile list failed: ${summarizeCommandResult(listed)}` };
  }
  const match = profiles?.find((item) =>
    String(item?.appId || item?.app_id || "").trim() === String(appId).trim() &&
    String(item?.name || "").trim(),
  );
  const profile = String(match?.name || "").trim();
  if (!profile) return { error: `no lark-cli profile matches OpenClaw appId=${appId}` };
  larkCliProfileByAppId.set(appId, { profile, resolvedAtMs: Date.now() });
  fileLog(`lark-cli profile resolved appId=${appId} profile=${profile}`);
  return { resolved: true, profile, source: "profile-list" };
}

function spawnLarkCliDeviceWait(deviceCode, profile = undefined) {
  const code = String(deviceCode || "").trim();
  if (!code) return { error: "no deviceCode" };
  const fullArgs = [...getLarkCliBaseArgs(profile), "auth", "login", "--device-code", code];
  if (larkCliDeviceWaitSpawnerForTest) {
    return larkCliDeviceWaitSpawnerForTest(fullArgs) || { started: true };
  }
  try {
    const child = spawn("lark-cli", fullArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const waiter = { started: true, pid: child.pid || null, exited: false, exitCode: null, signal: null };
    child.once("exit", (code, signal) => {
      waiter.exited = true;
      waiter.exitCode = code;
      waiter.signal = signal;
    });
    child.unref();
    waiter.cancel = () => {
      if (waiter.exited || waiter.cancelled) return;
      waiter.cancelled = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch {}
      }
    };
    return waiter;
  } catch (error) {
    return { error: formatError(error) };
  }
}

function getStatusString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isExplicitInvalidAccessTokenStatus(payload, userIdentity) {
  if (getStatusString(userIdentity?.status).toLowerCase() !== "verify_failed" || userIdentity?.verified !== false) {
    return false;
  }
  const errorCode = String(payload?.error?.code || payload?.code || "").trim();
  const message = [
    payload?.message,
    payload?.error?.message,
    payload?.error_description,
    userIdentity?.message,
  ]
    .map(getStatusString)
    .filter(Boolean)
    .join("\n");
  return (
    errorCode === "20005" ||
    /\[20005\]/u.test(message) ||
    /\bneed_user_authorization\b/iu.test(message)
  );
}

function isMissingUserIdentity(userIdentity) {
  return getStatusString(userIdentity?.status).toLowerCase() === "missing" && userIdentity?.available === false;
}

function isAuthCheckNotLoggedIn(payload, result) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const parts = [
    source?.error,
    source?.message,
    source?.reason,
    result?.stderr,
    result?.stdout,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.some((part) => /not_logged_in|no user logged in|identity:\s*missing/i.test(part));
}

async function checkUserGrantScopesViaLarkCli(scopes, profile, options = {}) {
  fileLog(`checkUserGrant: running lark-cli auth check scopeCount=${scopes.length} profile=${profile || "<default>"}`);
  const result = await runLarkCli(
    ["auth", "check", "--scope", scopes.join(" ")],
    { timeoutMs: 30000, profile },
  );
  const payload = extractJsonPayload(result.stdout, result.stderr);
  if (isAuthCheckNotLoggedIn(payload, result)) {
    fileLog(`checkUserGrant: lark-cli auth check reported not_logged_in profile=${profile || "<default>"}`);
    return { kind: "not_logged_in", reason: summarizeCommandResult(result) };
  }
  const normalized = normalizeGrantCheckResult(payload, scopes, options);
  if (!normalized?.hasScopeDetails) {
    fileLog(`checkUserGrant: lark-cli auth check lacked scope details profile=${profile || "<default>"} reason=${summarizeCommandResult(result)}`);
    return { kind: "unavailable", reason: summarizeCommandResult(result) };
  }
  fileLog(`checkUserGrant: lark-cli auth check normalized ok=${normalized.ok} missing=${JSON.stringify(normalized.missing)} granted=${JSON.stringify(normalized.granted)} profile=${profile || "<default>"}`);
  return {
    kind: "result",
    result: {
      ...normalized,
      source: "lark-cli-check",
      oauthState: normalized.ok ? "authorized" : "scope_missing",
    },
  };
}

function isReauthRequiredLarkCliStatus(payload, expectedAppId, openId) {
  const userIdentity = payload?.identities?.user;
  const status = getStatusString(userIdentity?.status).toLowerCase();
  const appMatches =
    Boolean(expectedAppId) &&
    getStatusString(payload?.appId || payload?.app_id) === getStatusString(expectedAppId);
  const requesterMatches = Boolean(openId) && (
    getStatusString(userIdentity?.openId || userIdentity?.open_id) === getStatusString(openId) ||
    (status === "missing" && userIdentity?.available === false && !getStatusString(userIdentity?.openId || userIdentity?.open_id))
  );
  if (!appMatches || !requesterMatches) return false;

  const isMissingUser = isMissingUserIdentity(userIdentity);
  return isMissingUser || isExplicitInvalidAccessTokenStatus(payload, userIdentity);
}

async function checkUserGrantViaLarkCli(openId, scopes, ctx = {}, options = {}) {
  const health = await checkLarkCliRuntimeReady();
  if (!health.ok) {
    const failed = {
      ok: false,
      missing: scopes,
      granted: [],
      unavailable: true,
      source: "lark-cli",
      oauthState: "oauth_runtime_unavailable",
      reason: health.error,
      precondition: "lark-cli",
    };
    fileLog(`checkUserGrant result ${formatGrantCheckForLog(failed, options)}`);
    return failed;
  }
  const expectedAppId = await getAppId(ctx).catch(() => null);
  const configuredProfile = getConfiguredLarkCliProfile();
  const cachedProfile = !configuredProfile && expectedAppId
    ? larkCliProfileByAppId.get(expectedAppId)
    : null;
  let profile = configuredProfile || cachedProfile?.profile || null;
  let result = await runLarkCli(
    ["auth", "status", "--verify"],
    { timeoutMs: 30000, profile },
  );
  let payload = extractJsonPayload(result.stdout, result.stderr);
  let userIdentity = payload?.identities?.user;
  const defaultProfileMatchesApp =
    !configuredProfile &&
    String(payload?.appId || payload?.app_id || "").trim() === String(expectedAppId || "").trim();
  if (defaultProfileMatchesApp && expectedAppId) {
    larkCliProfileByAppId.set(expectedAppId, { profile: null, resolvedAtMs: Date.now() });
  }
  if (!configuredProfile && !profile && !defaultProfileMatchesApp) {
    const profileResolution = await resolveLarkCliProfile(ctx);
    if (!profileResolution.resolved) {
      const failed = {
        ok: false,
        missing: scopes,
        granted: [],
        unavailable: true,
        source: "lark-cli",
        oauthState: "oauth_runtime_unavailable",
        reason: profileResolution.error || "lark-cli profile unavailable",
        precondition: "lark-cli-profile",
      };
      fileLog(`checkUserGrant result ${formatGrantCheckForLog(failed, options)}`);
      return failed;
    }
    profile = profileResolution.profile;
    result = await runLarkCli(["auth", "status", "--verify"], { timeoutMs: 30000, profile });
    payload = extractJsonPayload(result.stdout, result.stderr);
    userIdentity = payload?.identities?.user;
  }
  const reauthRequiredByStatus = isReauthRequiredLarkCliStatus(payload, expectedAppId, openId);
  if (reauthRequiredByStatus && isMissingUserIdentity(userIdentity)) {
    const authCheck = await checkUserGrantScopesViaLarkCli(scopes, profile, options);
    if (authCheck?.kind === "result") {
      fileLog(`checkUserGrant result ${formatGrantCheckForLog(authCheck.result, options)}`);
      return authCheck.result;
    }
  }
  if (reauthRequiredByStatus) {
    const reauthRequired = {
      ok: false,
      missing: scopes,
      granted: [],
      source: "lark-cli-status",
      oauthState: "oauth_reauth_required",
      reason: summarizeCommandResult(result),
    };
    fileLog(`checkUserGrant result ${formatGrantCheckForLog(reauthRequired, options)}`);
    return reauthRequired;
  }
  const commandSucceeded = result?.ok === true || (result?.code === 0 && !result?.error);
  const statusMatchesRequester =
    commandSucceeded &&
    Boolean(expectedAppId) &&
    String(payload?.appId || payload?.app_id || "").trim() === String(expectedAppId).trim() &&
    String(userIdentity?.openId || userIdentity?.open_id || "").trim() === String(openId || "").trim() &&
    userIdentity?.available === true &&
    userIdentity?.verified === true;
  if (statusMatchesRequester) {
    const normalized = normalizeGrantCheckResult(
      { scope: userIdentity.scope || userIdentity.scopes || [] },
      scopes,
      options,
    );
    if (normalized) {
      const withSource = {
        ...normalized,
        source: "lark-cli-status",
        oauthState: normalized.ok ? "authorized" : "scope_missing",
      };
      fileLog(`checkUserGrant result ${formatGrantCheckForLog(withSource, options)}`);
      return withSource;
    }
  }
  const fallback = {
    ok: false,
    missing: scopes,
    granted: [],
    unavailable: true,
    source: "lark-cli",
    oauthState: "oauth_runtime_unavailable",
    reason: summarizeCommandResult(result),
  };
  fileLog(`checkUserGrant result ${formatGrantCheckForLog(fallback, options)}`);
  return fallback;
}

async function startUserGrantLogin(scopes, ctx = {}) {
  const profileResolution = await resolveLarkCliProfile(ctx);
  if (!profileResolution.resolved) {
    return { error: profileResolution.error || "lark-cli profile unavailable", precondition: "lark-cli-profile" };
  }
  const health = await checkLarkCliRuntimeReady(profileResolution.profile);
  if (!health.ok) {
    return { error: health.error, precondition: "lark-cli" };
  }
  const result = await runLarkCli(
    ["auth", "login", "--scope", scopes.join(" "), "--no-wait", "--json"],
    { timeoutMs: 30000, profile: profileResolution.profile },
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
  const waiter = spawnLarkCliDeviceWait(deviceCode, profileResolution.profile);
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
    authWaiter: waiter?.error ? null : waiter,
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
  } else if (
    requestedAccountId === "default" &&
    accountIds.length === 0 &&
    feishuCfg.appId &&
    feishuCfg.appSecret
  ) {
    // 兼容根级单账号配置：飞书消息上下文可能显式传入 default。
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
      return await startUserGrantLogin(missing, ctx);
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
function normalizeGrantCheckResult(response, requestedScopes, options = {}) {
  if (!response) return null;
  const source = response.data && typeof response.data === "object" ? response.data : response;
  const acceptEmptyMissing = options.acceptEmptyMissing === true;
  const requireScopeDetails = options.requireScopeDetails === true;
  const grantedScopes =
    source.grantedScopes ||
    source.granted_scopes ||
    (Array.isArray(source.granted) ? source.granted : null) ||
    source.scopes ||
    source.scope ||
    [];
  const hasMissingField = Object.prototype.hasOwnProperty.call(source, "missingScopes") ||
    Object.prototype.hasOwnProperty.call(source, "missing_scopes") ||
    Object.prototype.hasOwnProperty.call(source, "missing");
  const missingScopes = source.missingScopes || source.missing_scopes || source.missing || [];
  const granted = Array.isArray(grantedScopes)
    ? grantedScopes.map(String).filter(Boolean)
    : String(grantedScopes || "").split(/[\s,]+/u).filter(Boolean);
  const explicitMissing = Array.isArray(missingScopes)
    ? missingScopes.map(String).filter(Boolean)
    : String(missingScopes || "").split(/[\s,]+/u).filter(Boolean);
  const grantedSet = new Set(granted);
  const hasScopeDetails = granted.length > 0 || explicitMissing.length > 0;
  const positiveResult = source.ok === true || source.authorized === true || source.granted === true;
  const acceptedEmptyMissing = acceptEmptyMissing && hasMissingField && positiveResult && explicitMissing.length === 0 && !requireScopeDetails;
  const missing = explicitMissing.length
    ? explicitMissing
    : granted.length
      ? requestedScopes.filter((scope) => !grantedSet.has(scope))
      : acceptedEmptyMissing
        ? []
        : requestedScopes;
  const ok = missing.length === 0 && (hasScopeDetails || acceptedEmptyMissing);
  const result = {
    ok,
    granted: ok && !hasScopeDetails ? requestedScopes : requestedScopes.filter((scope) => !missing.includes(scope)),
    missing,
    hasScopeDetails,
  };
  if (!ok && requireScopeDetails && !hasScopeDetails) {
    result.reason = "user grant check did not include granted scope details";
  } else if (!ok && source.ok === true && granted.length === 0 && !hasMissingField) {
    result.reason = "user grant check did not include scope details";
  }
  return result;
}

function getRuntimeCheckerResponseData(response) {
  return response?.data && typeof response.data === "object" ? response.data : response;
}

function hasTrustedRuntimeGrantAttestation(response, expectedAppId, expectedOpenId) {
  const source = getRuntimeCheckerResponseData(response);
  const receivedAppId = String(source?.appId || source?.app_id || "").trim();
  const receivedOpenId = String(source?.openId || source?.open_id || "").trim();
  return source?.serverVerified === true &&
    Boolean(expectedAppId) &&
    Boolean(expectedOpenId) &&
    receivedAppId === String(expectedAppId).trim() &&
    receivedOpenId === String(expectedOpenId).trim();
}

function formatGrantCheckForLog(result, options = {}) {
  const payload = {
    ok: result?.ok === true,
    missing: Array.isArray(result?.missing) ? result.missing : [],
    granted: Array.isArray(result?.granted) ? result.granted : [],
    hasScopeDetails: result?.hasScopeDetails === true,
    source: result?.source || null,
    reason: result?.reason || null,
    unavailable: result?.unavailable === true,
    precondition: result?.precondition || null,
    oauthState: result?.oauthState || null,
    options: {
      requireScopeDetails: options?.requireScopeDetails === true,
      acceptEmptyMissing: options?.acceptEmptyMissing === true,
    },
  };
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
export async function checkUserGrant(openId, scopes, ctx, options = {}) {
  if (!scopes?.length) {
    const empty = { ok: true, missing: [], granted: [], hasScopeDetails: true, source: "empty-scopes" };
    fileLog(`checkUserGrant result ${formatGrantCheckForLog(empty, options)}`);
    return empty;
  }
  if (!openId) {
    const failed = {
      ok: false,
      missing: scopes,
      granted: [],
      unavailable: true,
      oauthState: "oauth_runtime_unavailable",
      reason: "no openId",
      source: "runtime",
    };
    fileLog(`checkUserGrant result ${formatGrantCheckForLog(failed, options)}`);
    return failed;
  }
  const tools = pluginApiRef?.tools || {};
  const checker =
    tools.openclaw_lark_check_user_grant ||
    tools.feishu_auth_check_user_grant ||
    tools.lark_auth_check_user_grant ||
    null;
  fileLog(`checkUserGrant: entry openId=${openId} scopeCount=${scopes.length} hasRuntimeChecker=${checker ? "yes" : "no"}`);
  if (!checker) {
    return await checkUserGrantViaLarkCli(openId, scopes, ctx, options);
  }
  try {
    const appId = await getAppId(ctx).catch(() => null);
    fileLog(`checkUserGrant: invoking runtime checker appId=${appId || "<unknown>"} accountId=${getAccountId(ctx) || "<unknown>"}`);
    const response = await checker({
      openId,
      scopes,
      accountId: getAccountId(ctx),
      appId,
    });
    const normalized = normalizeGrantCheckResult(response, scopes, options);
    if (normalized?.hasScopeDetails && hasTrustedRuntimeGrantAttestation(response, appId, openId)) {
      const verified = {
        ...normalized,
        source: "runtime-checker",
        oauthState: normalized.ok ? "authorized" : "scope_missing",
      };
      fileLog(`checkUserGrant result ${formatGrantCheckForLog(verified, options)}`);
      return verified;
    }
    fileLog(`checkUserGrant: checker response lacks trusted server attestation or scope details; falling back to lark-cli`);
    return await checkUserGrantViaLarkCli(openId, scopes, ctx, options);
  } catch (error) {
    fileLog(`checkUserGrant: failed: ${formatError(error)}; falling back to lark-cli`);
    return await checkUserGrantViaLarkCli(openId, scopes, ctx, options);
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

function cancelAuthWaiter(waiter) {
  if (!waiter || waiter.exited || waiter.cancelled) return;
  try {
    if (typeof waiter.cancel === "function") waiter.cancel();
    else if (typeof waiter.kill === "function") waiter.kill("SIGTERM");
    else if (typeof waiter.child?.kill === "function") waiter.child.kill("SIGTERM");
    waiter.cancelled = true;
  } catch (error) {
    fileLog(`waitForAuth: device waiter cancellation failed: ${error?.message || error}`);
  }
}

async function sendInteractiveCard(receiveId, receiveIdType, card, timeoutMs = 20000, ctx = {}) {
  if (!receiveId) return { error: "no receiveId" };
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    fileLog(`sendInteractiveCard: using plugin tool receiveId=${receiveId} receiveIdType=${receiveIdType}`);
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "send",
        receive_id: receiveId,
        receive_id_type: receiveIdType,
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
      `sendInteractiveCard: plugin tool unavailable, falling back to HTTP receiveId=${receiveId} receiveIdType=${receiveIdType}`,
    );
  }
  const credentials = await getAccountCredentials(ctx);
  try {
    fileLog(
      `sendInteractiveCard: using HTTP fallback accountId=${credentials.accountId} receiveId=${receiveId} receiveIdType=${receiveIdType}`,
    );
    const response = await callFeishuOpenApi(credentials, {
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: receiveIdType },
      body: {
        receive_id: receiveId,
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

export async function updateInteractiveCard(messageId, card, ctx = {}) {
  const mid = String(messageId || "").trim();
  if (!mid || mid === "sent") return { error: "no messageId" };
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "update",
        message_id: mid,
        msg_type: "interactive",
        content: JSON.stringify(card),
      });
      if (isFeishuMutationSuccessful(response)) return { messageId: mid };
      fileLog(`updateInteractiveCard: plugin tool update failed: ${formatFeishuApiResponseError(response)}`);
    } catch (error) {
      fileLog(`updateInteractiveCard: plugin tool update failed: ${formatError(error)}`);
    }
  }
  try {
    const response = await callFeishuOpenApi(await getAccountCredentials(ctx), {
      method: "PATCH",
      path: `/open-apis/im/v1/messages/${encodeURIComponent(mid)}`,
      body: { content: JSON.stringify(card) },
    });
    if (isFeishuMutationSuccessful(response)) return { messageId: mid };
    return { error: formatFeishuApiResponseError(response) };
  } catch (error) {
    return { error: formatError(error) };
  }
}

function buildAuthStageDoneCard({ skillName, authReason = "app_scope", userGrantComplete = false }) {
  const isUserGrant = authReason === "user_grant";
  const title = isUserGrant ? "飞书用户授权已完成" : "飞书应用权限已开通";
  const subtitle = isUserGrant
    ? `技能 “${skillName}” 已完成用户身份授权`
    : userGrantComplete
      ? `技能 “${skillName}” 已完成应用权限开通和用户授权`
      : `技能 “${skillName}” 已完成应用权限开通`;
  const content = isUserGrant
    ? `技能 **${skillName}** 的用户授权已完成。`
    : userGrantComplete
      ? `技能 **${skillName}** 的应用权限已开通，当前用户授权也已完成。`
      : `技能 **${skillName}** 的应用权限已开通，继续进行用户授权。`;
  const statusText = isUserGrant
    ? "<font color='green'>✅ 用户授权完成</font>"
    : userGrantComplete
      ? "<font color='green'>✅ 应用权限开通完成，用户授权已完成</font>"
      : "<font color='green'>✅ 应用权限开通完成</font>";
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "green",
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      text_tag_list: LARK_AUTH_CARD_HEADER_TAGS,
      icon: { tag: "standard_icon", token: "check_outlined" },
    },
    body: {
      elements: [
        { tag: "markdown", content },
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
              elements: [{ tag: "markdown", content: statusText }],
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
}

function buildAuthStageFailureCard({ skillName, state, authReason = "user_grant" }) {
  const timedOut = state === "timeout";
  const runtimeUnavailable = state === "oauth_runtime_unavailable";
  const appScope = authReason === "app_scope";
  const subject = appScope ? "飞书应用权限开通" : "飞书用户授权";
  const title = runtimeUnavailable
    ? "飞书用户授权运行时不可用"
    : timedOut ? `${subject}超时` : "飞书用户授权未完成";
  const subtitle = runtimeUnavailable
    ? `技能 “${skillName}” 的用户授权运行时当前不可用`
    : timedOut
      ? `技能 “${skillName}” 的${appScope ? "应用权限开通" : "用户授权"}已超时`
      : `技能 “${skillName}” 的用户授权已取消或未完成`;
  const content = runtimeUnavailable
    ? "授权运行时当前不可用，请检查 OAuth 运行时后重试。"
    : timedOut
      ? `${appScope ? "应用权限开通" : "授权"}超时，请重新触发技能后再次授权。`
      : "授权被取消或未成功完成，请重新触发技能后再次授权。";
  const statusText = timedOut
    ? "<font color='orange'>⏱ 授权超时</font>"
    : runtimeUnavailable
      ? "<font color='red'>✖ 授权运行时不可用</font>"
    : "<font color='red'>✖ 授权未完成</font>";
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: timedOut ? "orange" : "red",
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      text_tag_list: LARK_AUTH_CARD_HEADER_TAGS,
      icon: { tag: "standard_icon", token: timedOut ? "time_outlined" : "close_outlined" },
    },
    body: {
      elements: [
        { tag: "markdown", content: `技能 **${skillName}** ${content}` },
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
              elements: [{ tag: "markdown", content: statusText }],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: [{
                tag: "img",
                img_key: LARK_AUTH_CARD_FOOTER_IMAGE_KEY,
                alt: { tag: "plain_text", content: "Paper" },
                scale_type: "crop_center",
                size: "80px 24px",
                transparent: true,
                preview: false,
                margin: "0 0 0 8px",
              }],
            },
          ],
        },
      ],
    },
  };
}

async function updateAuthStageCard({ messageId, skillName, authReason, accountId, userGrantComplete = false }) {
  if (!messageId || messageId === "sent") return { error: "no messageId" };
  const result = await updateInteractiveCard(
    messageId,
    buildAuthStageDoneCard({ skillName, authReason, userGrantComplete }),
    { accountId },
  );
  if (result?.messageId) {
    fileLog(`auth card updated skill="${skillName}" authReason=${authReason} userGrantComplete=${userGrantComplete} msg=${messageId}`);
  } else if (result?.error) {
    fileLog(`auth card update failed skill="${skillName}" authReason=${authReason}: ${result.error}`);
  }
  return result;
}

async function updateAuthFailureCard({ messageId, skillName, accountId, state, authReason }) {
  if (!messageId || messageId === "sent") return { error: "no messageId" };
  const result = await updateInteractiveCard(
    messageId,
    buildAuthStageFailureCard({ skillName, state, authReason }),
    { accountId },
  );
  if (result?.messageId) {
    fileLog(`auth card updated skill="${skillName}" state=${state} msg=${messageId}`);
  } else if (result?.error) {
    fileLog(`auth card failure update failed skill="${skillName}" state=${state}: ${result.error}`);
  }
  return result;
}
export function startWaitForAuth({
  authTargetKey,
  skillName,
  deviceCode,
  missingKey,
  openId,
  scopes,
  requiredScopes = null,
  identity = "user",
  authReason = "app_scope",
  ctx,
  authMessageId = null,
  authWaiter = null,
  onAuthorized = null,
  onAuthCardSent = null,
}) {
  if (!deviceCode && authReason === "user_grant") return;
  // 如果该技能已有轮询在跑，先清理旧的，避免重复
  const pollingKey = authTargetKey || skillName;
  const existing = activePollingIntervals.get(pollingKey);
  if (existing) {
    clearInterval(existing.interval);
    existing.active = false;
    cancelAuthWaiter(existing.authWaiter);
    fileLog(`waitForAuth: replacing existing poll for "${pollingKey}"`);
  }

  fileLog(
    `waitForAuth: starting for "${skillName}" deviceCode=${deviceCode ? `${deviceCode.slice(0, 12)}...` : "<none>"}`,
  );
  const t0 = Date.now();
  // 轮询间隔 15 秒（用户手动授权通常需要更长时间，无需高频请求）
  const POLL_MS = 15000;
  // 最大等待 3 分钟，与发卡冷却时间一致
  const MAX_WAIT_MS = 180000;
  let interval = null;
  let completed = false;
  const entry = { interval: null, active: true, authWaiter };

  // 注册到全局 map，供后续去重。entry identity also prevents an old in-flight
  // poll from clearing or completing the poll that replaced it.
  activePollingIntervals.set(pollingKey, entry);
  const isActive = () => entry.active && !completed && activePollingIntervals.get(pollingKey) === entry;

  const cleanup = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    completed = true;
    entry.active = false;
    cancelAuthWaiter(authWaiter);
    if (activePollingIntervals.get(pollingKey) === entry) {
      activePollingIntervals.delete(pollingKey);
    }
  };

  const poll = async () => {
    if (!isActive()) return;
    try {
      const elapsed = Date.now() - t0;
      if (elapsed > MAX_WAIT_MS) {
        fileLog(
          `waitForAuth: "${skillName}" timed out after ${Math.round(elapsed / 1000)}s`,
        );
        if (authMessageId) {
          fileLog(`waitForAuth: updating timed-out auth card skill="${skillName}" authReason=${authReason} msg=${authMessageId}`);
          await updateAuthFailureCard({
            messageId: authMessageId,
            skillName,
            accountId: ctx?.accountId || ctx?.account,
            state: "timeout",
            authReason,
          });
        }
        cleanup();
        return;
      }

      const normalizedIdentity = normalizeAuthIdentity(identity);
      const userRequiredScopes = Array.isArray(requiredScopes) && requiredScopes.length ? requiredScopes : scopes;
      const check = authReason === "user_grant"
        ? await checkUserGrant(openId, userRequiredScopes, ctx, { acceptEmptyMissing: true })
        : await checkScopes(scopes, ctx, { identity: normalizedIdentity });
      if (!isActive()) return;
      if (authReason === "user_grant") {
        fileLog(`waitForAuth: "${skillName}" user grant poll result ${formatGrantCheckForLog(check, { acceptEmptyMissing: true })}`);
      }
      if (authReason === "user_grant" && authWaiter?.exited && !check?.ok) {
        fileLog(`waitForAuth: "${skillName}" user grant waiter exited without authorization code=${authWaiter.exitCode ?? "unknown"}`);
        if (authMessageId) {
          await updateAuthFailureCard({
            messageId: authMessageId,
            skillName,
            accountId: ctx?.accountId || ctx?.account,
            state: check?.oauthState === "oauth_runtime_unavailable" ? "oauth_runtime_unavailable" : "cancelled",
            authReason,
          });
        }
        cleanup();
        return;
      }
      if (check?.ok) {
        if (authMessageId) {
          await updateAuthStageCard({
            messageId: authMessageId,
            skillName,
            authReason,
            accountId: ctx?.accountId || ctx?.account,
          });
          if (!isActive()) return;
        }
        if (normalizedIdentity === "user" && authReason !== "user_grant") {
          const userRequiredScopes = Array.isArray(requiredScopes) && requiredScopes.length ? requiredScopes : scopes;
          const userGrantCheck = await checkUserGrant(openId, userRequiredScopes, ctx, { requireScopeDetails: true });
          if (!isActive()) return;
          fileLog(`waitForAuth: "${skillName}" user grant precheck result ${formatGrantCheckForLog(userGrantCheck, { requireScopeDetails: true })}`);
          if (userGrantCheck.ok) {
            fileLog(
              `waitForAuth: "${skillName}" app scope authorized and user grant verified with scope details`,
            );
          } else {
            const userGrantMissing = userGrantCheck.missing?.length ? userGrantCheck.missing : userRequiredScopes;
            const oauthState = userGrantCheck.oauthState || null;
            fileLog(
              `waitForAuth: "${skillName}" app scope authorized, user grant missing or unverifiable: ${userGrantMissing.join(", ")} reason=${userGrantCheck.reason || "not granted"}`,
            );
            const login = await startLogin(userRequiredScopes, ctx, {
              identity: "user",
              authReason: "user_grant",
              ...(oauthState ? { oauthState } : {}),
            });
          if (!isActive()) return;
          if (login?.verificationUrl) {
            const sent = await sendAuthCard({
              skillName,
              missing: userGrantMissing,
              ...login,
              openId,
              accountId: ctx?.accountId || ctx?.account,
              identity: "user",
              authReason: "user_grant",
              ...(oauthState ? { oauthState } : {}),
            });
            if (!isActive()) return;
            if (sent?.messageId) {
              cleanup();
              fileLog(
                `waitForAuth: "${skillName}" app scope authorized; user grant card sent msg=${sent.messageId}`,
              );
              if (typeof onAuthCardSent === "function") {
                try {
                  await onAuthCardSent({
                    authTargetKey,
                    skillName,
                    missingKey: userRequiredScopes.slice().sort().join("|"),
                    openId,
                    scopes: userGrantMissing,
                    requiredScopes: userRequiredScopes,
                    identity: "user",
                    authReason: "user_grant",
                    messageId: sent.messageId,
                    ctx,
                  });
                  if (!isActive()) return;
                } catch (callbackError) {
                  fileLog(`waitForAuth: onAuthCardSent callback failed for "${skillName}": ${callbackError?.message || callbackError}`);
                }
              }
              startWaitForAuth({
                authTargetKey,
                skillName,
                deviceCode: login.deviceCode,
                missingKey: userRequiredScopes.slice().sort().join("|"),
                openId,
                scopes: userGrantMissing,
                requiredScopes: userRequiredScopes,
                identity: "user",
                authReason: "user_grant",
                ctx,
                authMessageId: sent.messageId,
                authWaiter: login.authWaiter,
                onAuthorized,
                onAuthCardSent,
              });
              return;
            }
            fileLog(
              `waitForAuth: "${skillName}" user grant card failed after app scope authorization: ${sent?.error || "send failed"}`,
            );
            return;
          }
            fileLog(
              `waitForAuth: "${skillName}" start user grant after app scope authorization failed: ${login?.error || "unknown error"}`,
            );
            return;
          }
        }
        cleanup();
        fileLog(
          `waitForAuth: "${skillName}" authorized! identity=${normalizedIdentity} authReason=${authReason} (${Math.round(elapsed / 1000)}s)`,
        );
        if (typeof onAuthorized === "function") {
          try {
            await onAuthorized({
              authTargetKey,
              skillName,
              missingKey,
              openId,
              scopes,
              identity: normalizedIdentity,
              authReason,
              ctx,
            });
          } catch (callbackError) {
            fileLog(`waitForAuth: onAuthorized callback failed for "${skillName}": ${callbackError?.message || callbackError}`);
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
  entry.interval = interval;
  poll();
}

export async function sendAuthCard({
  skillName,
  missing,
  verificationUrl,
  userCode,
  openId,
  receiveId = null,
  receiveIdType = null,
  accountId,
  identity = "user",
  authReason = "app_scope",
  oauthState = null,
}) {
  const target = receiveId
    ? { receiveId, receiveIdType: receiveIdType || "open_id" }
    : openId
      ? { receiveId: openId, receiveIdType: "open_id" }
      : null;
  if (!target) return { error: "no receiveId" };
  // 用 sidebar-semi applink 包裹，在飞书内以侧边栏打开，不跳转系统浏览器
  const authUrl = sidebarApplink(verificationUrl);
  fileLog(
    `sendAuthCard: skill="${skillName}" authUrl=${authUrl || "<EMPTY!>"} userCode=${userCode || "<none>"} receiveId=${target.receiveId} receiveIdType=${target.receiveIdType}`,
  );
  const scopeCount = missing.length;
  const scopeLines = missing.map((s) => `• \`${s}\``).join("\n");
  const normalizedIdentity = normalizeAuthIdentity(identity);
  const isUserGrant = authReason === "user_grant";
  const isReauthorization = oauthState === "oauth_reauth_required";
  const isScopeMissing = oauthState === "scope_missing";
  const authTitle = isUserGrant ? "飞书用户授权提醒" : "飞书应用权限开通提醒";
  const authSubtitle = isUserGrant
    ? `技能 “${skillName}” 需要你授权用户身份`
    : `技能 “${skillName}” 需要开通${normalizedIdentity === "user" ? "用户身份" : "应用身份"}权限`;
  const authIntro = isReauthorization
    ? `技能需要你重新授权用户身份，以恢复 **${scopeCount}** 项飞书权限访问。`
    : isScopeMissing
    ? `当前授权缺少所需权限，技能需要补齐 **${scopeCount}** 项飞书权限访问。`
    : isUserGrant
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
  return sendInteractiveCard(target.receiveId, target.receiveIdType, card, 20000, { accountId });
}
