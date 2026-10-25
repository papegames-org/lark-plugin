// utils.js — OpenClaw Skill Runtime 工具函数集
// 包含：日志、workspace 查找、skill-map 构建、auth 操作等（frontmatter 解析已移至 parse-meta.js）
// ============================================================

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import {
  beginScopeGrantFlow,
  callFeishuOpenApi,
  pollScopeGrantRegistration,
  resolveFeishuBrand,
  uploadImFile,
} from "./feishu-runtime.js";
import { isUserOpenIdScope, readLarkAuth } from "./parse-meta.js";
import {
  buildDiagnosticDocument,
  formatCardFailureHint,
  formatUserFacingFailureSummary,
  writeAuthDiagnosticFile,
} from "./auth-diagnostics.js";

// ---------- 模块级状态（与 index.js register 共享）----------

/** workspace 缓存（按 sessionId） */
export const cachedWorkspaceBySession = new Map();
/** account 缓存（按 sessionId/sessionKey） */
export const cachedAccountBySession = new Map();
/** agentId 缓存（按 sessionId/sessionKey，供 tool hook 回溯当前 agent） */
export const cachedAgentBySession = new Map();
/** sender/openId 缓存（按 sessionId/sessionKey） */
export const cachedSenderBySession = new Map();
/** 已成功解析的飞书凭据（按 session，供多账号场景回溯 accountId/appId） */
const resolvedCredentialsBySession = new Map();
/** register 时拿到的 api.config 引用（权威来源，免读文件）
 *  导出为 let 绑定，index.js 通过 setApiConfigRef() 写入 */
export let apiConfigRef = null;
/** 插件私有配置引用（api.pluginConfig），由 index.js register 写入 */
export let pluginConfigRef = null;
const runtimeHealthCacheByKey = new Map();
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

export function setPluginConfigRef(val) {
  pluginConfigRef = val || null;
}

export function setPluginApiRef(val) {
  pluginApiRef = val || null;
}

export function resetRuntimeCaches() {
  runtimeHealthCacheByKey.clear();
  resolvedCredentialsBySession.clear();
  appScopesCache.clear();
  larkCliProfileByAppId.clear();
  larkCliBindingStateByAppId.clear();
  clearActivePollingIntervals();
}

// ---------- 日志 ----------

/** grep 用：确认 Gateway 已加载含 scopeGrantDevicePoll 的版本 */
export const PLUGIN_RUNTIME_BUILD = "2.0.5+authDiagnostics.8";

/** 授权失败时是否向飞书发送诊断日志（IM 文件回复/单聊文件/文本通知）。本地 diagnostics 写入不受影响。 */
const AUTH_FAILURE_DIAGNOSTIC_SEND_ENABLED = false;

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
      senderOpenId: ctx?.senderOpenId,
      openId: ctx?.openId,
      chatId: ctx?.chatId,
      channelContextKeys: ctx?.channelContext ? Object.keys(ctx.channelContext) : null,
      channelContextSenderId: ctx?.channelContext?.sender?.id ?? null,
      channelContextSenderKeys: ctx?.channelContext?.sender ? Object.keys(ctx.channelContext.sender) : null,
      channelContextChatId: ctx?.channelContext?.chat?.id ?? null,
      requesterKeys: ctx?.requester ? Object.keys(ctx.requester) : null,
      requesterSenderId: ctx?.requester?.senderId ?? null,
      trustedSenderOpenId: extractTrustedSenderOpenId(null, ctx).openId,
      messageId: ctx?.messageId,
      sessionKey: ctx?.sessionKey,
      sessionId: ctx?.sessionId,
      agentId: ctx?.agentId,
      workspaceDir: ctx?.workspaceDir || null,
      channelId: ctx?.channelId,
      channel: ctx?.channel,
      messageProvider: ctx?.messageProvider,
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

function normalizeAgentId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeWorkspacePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return resolve(expandHome(value.trim()));
  } catch {
    return null;
  }
}

/** 从 agents.list.workspace 反查 agentId（hook 缺 agentId 时的兜底） */
export function lookupAgentIdByWorkspace(workspaceDir) {
  const needle = normalizeWorkspacePath(workspaceDir);
  if (!needle) return null;
  const cfg = apiConfigRef;
  const list = cfg?.agents?.list;
  if (!Array.isArray(list)) return null;
  for (const agent of list) {
    const id = normalizeAgentId(agent?.id);
    if (!id) continue;
    const ws = normalizeWorkspacePath(
      agent?.workspace || cfg?.agents?.defaults?.workspace || "",
    );
    if (ws && ws === needle) {
      fileLog(`agentId: from workspace -> ${id}`);
      return id;
    }
  }
  return null;
}

export function cacheAgentIdForSession(ctx, agentId) {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return null;
  for (const key of getSessionRecallKeys(ctx)) {
    cachedAgentBySession.set(key, normalized);
  }
  return normalized;
}

/** 解析当前 hook 应使用的 agentId：ctx → session 缓存 → workspace 反查 */
export function resolveAgentId(ctx) {
  const direct = normalizeAgentId(ctx?.agentId);
  if (direct) return direct;
  for (const key of getSessionRecallKeys(ctx)) {
    if (cachedAgentBySession.has(key)) {
      return normalizeAgentId(cachedAgentBySession.get(key));
    }
  }
  if (ctx?.sessionId && cachedWorkspaceBySession.has(ctx.sessionId)) {
    const fromWs = lookupAgentIdByWorkspace(cachedWorkspaceBySession.get(ctx.sessionId));
    if (fromWs) return fromWs;
  }
  if (ctx?.workspaceDir) {
    return lookupAgentIdByWorkspace(ctx.workspaceDir);
  }
  return null;
}

function mergeFeishuAccountLayer(feishuCfg, accountEntry = {}) {
  return { ...feishuCfg, ...(accountEntry && typeof accountEntry === "object" ? accountEntry : {}) };
}

function feishuAccountLayerHasCredentials(layer) {
  return Boolean(String(layer?.appId || "").trim() && String(layer?.appSecret || "").trim());
}

/** 能独立发 API 的 accountId 列表（含根级凭据合并后的 default） */
export function listConfiguredFeishuAccountIds(feishuCfg, accounts = feishuCfg?.accounts) {
  const map = accounts && typeof accounts === "object" ? accounts : {};
  const ids = new Set();
  if (feishuAccountLayerHasCredentials(mergeFeishuAccountLayer(feishuCfg, map.default))) {
    ids.add("default");
  }
  for (const [accountId, entry] of Object.entries(map)) {
    if (accountId === "default") continue;
    if (feishuAccountLayerHasCredentials(mergeFeishuAccountLayer(feishuCfg, entry))) {
      ids.add(accountId);
    }
  }
  if (ids.size === 0 && feishuAccountLayerHasCredentials(feishuCfg)) {
    ids.add("default");
  }
  return [...ids];
}

function routingCtxWithAgent(ctx) {
  const agentId = resolveAgentId(ctx);
  if (!agentId || agentId === ctx?.agentId) return ctx;
  return { ...ctx, agentId };
}

/** agentId 与 accounts key 一致，或 main → default（根级/accounts.default 有凭据） */
export function lookupAccountIdByAgentConvention(ctx) {
  const agentId = resolveAgentId(ctx);
  if (!agentId) return null;
  const { feishuCfg, accounts } = listFeishuAccountEntries();
  if (accounts[agentId] && feishuAccountLayerHasCredentials(mergeFeishuAccountLayer(feishuCfg, accounts[agentId]))) {
    return normalizeAccountId(agentId);
  }
  if (agentId === "main") {
    if (feishuAccountLayerHasCredentials(mergeFeishuAccountLayer(feishuCfg, accounts.default))) {
      return "default";
    }
    if (feishuAccountLayerHasCredentials(feishuCfg)) {
      return "default";
    }
  }
  return null;
}

// ---------- skill-map：workspace 只走 agentId -> openclaw.json ----------

export function resolveWorkspaceDir(ctx) {
  if (ctx?.workspaceDir) {
    if (ctx?.sessionId) cachedWorkspaceBySession.set(ctx.sessionId, ctx.workspaceDir);
    if (ctx?.sessionKey) cachedWorkspaceBySession.set(ctx.sessionKey, ctx.workspaceDir);
    fileLog(`workspace: from ctx.workspaceDir=${ctx.workspaceDir}`);
    return ctx.workspaceDir;
  }
  if (ctx?.sessionId && cachedWorkspaceBySession.has(ctx.sessionId)) {
    const cached = cachedWorkspaceBySession.get(ctx.sessionId);
    fileLog(`workspace: from cache (sessionId=${ctx.sessionId}) -> ${cached}`);
    return cached;
  }
  if (ctx?.sessionKey && cachedWorkspaceBySession.has(ctx.sessionKey)) {
    const cached = cachedWorkspaceBySession.get(ctx.sessionKey);
    fileLog(`workspace: from cache (sessionKey=${ctx.sessionKey}) -> ${cached}`);
    return cached;
  }
  const agentId = resolveAgentId(ctx);
  if (agentId) {
    const ws = lookupWorkspaceByAgentId(agentId);
    if (ws) {
      fileLog(`workspace: from agentId=${agentId} -> ${ws}`);
      return ws;
    }
  }
  fileLog(
    `workspace: no ctx.workspaceDir and no cache for agentId=${ctx?.agentId || agentId || "<empty>"} — returning null`,
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

export function getOpenClawManagedSkillsRoot() {
  const openclawHome = getOpenClawHomeDir();
  return openclawHome ? resolve(join(openclawHome, "skills")) : null;
}

export function inferOpenClawHomeFromSkillPath(skillPath) {
  if (!skillPath) return null;
  const normalized = String(skillPath).replace(/\\/g, "/");
  const marker = "/.openclaw/";
  const idx = normalized.toLowerCase().indexOf(marker);
  if (idx === -1) return null;
  return resolve(normalized.slice(0, idx + "/.openclaw".length));
}

export function listOpenClawBundledSkillRoots(options = {}) {
  const homes = [];
  const explicit = options.openclawHome === undefined ? getOpenClawHomeDir() : options.openclawHome;
  if (explicit) homes.push(explicit);
  const inferred = inferOpenClawHomeFromSkillPath(options.skillPath);
  if (inferred) homes.push(inferred);

  const roots = [];
  const seenHomes = new Set();
  for (const home of homes) {
    const resolvedHome = resolve(home);
    if (seenHomes.has(resolvedHome)) continue;
    seenHomes.add(resolvedHome);
    roots.push(join(resolvedHome, "skills"));
    roots.push(join(resolvedHome, "workspace", "skills"));
    const workspace = join(resolvedHome, "workspace");
    if (!existsSync(workspace)) continue;
    let entries = [];
    try {
      entries = readdirSync(workspace, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      roots.push(join(workspace, entry.name, "skills"));
    }
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

export function getDefaultSkillRoots(ctx) {
  const ws = resolveWorkspaceDir(ctx);
  const roots = [join(homedir(), ".agents", "skills")];
  if (ws) roots.push(join(ws, "skills"));
  const openclawHome = getOpenClawHomeDir();
  if (openclawHome) {
    roots.push(join(openclawHome, "skills"));
    roots.push(join(openclawHome, "workspace", "skills"));
  }
  return [...new Set(roots.map((root) => resolve(expandHome(root))))];
}

function grantsDeclaredByAuth(auth, scope) {
  const multi = auth?.scopeInstallGrants?.[scope];
  if (Array.isArray(multi) && multi.length) {
    return multi.filter((grant) => grant === "app" || grant === "user");
  }
  const single = auth?.scopeInstallGrant?.[scope];
  if (single === "app" || single === "user") return [single];
  return [];
}

export function mergeLarkAuthDeclarations(declarations) {
  const usable = (declarations || []).filter((auth) => auth && Array.isArray(auth.scopes) && auth.scopes.length);
  if (!usable.length) return null;

  const scopeSet = new Set();
  const grantSets = new Map();
  let identity = "app";
  for (const auth of usable) {
    if (normalizeAuthIdentity(auth.identity) === "user") identity = "user";
    for (const scope of auth.scopes) {
      const normalized = String(scope || "").trim();
      if (!normalized || isUserOpenIdScope(normalized)) continue;
      scopeSet.add(normalized);
      const bucket = grantSets.get(normalized) || new Set();
      const declared = grantsDeclaredByAuth(auth, normalized);
      if (!declared.length) bucket.add("unknown");
      for (const grant of declared) bucket.add(grant);
      grantSets.set(normalized, bucket);
    }
  }

  const scopes = [...scopeSet].sort();
  const scopeInstallGrant = {};
  const scopeInstallGrants = {};
  for (const scope of scopes) {
    const grants = grantSets.get(scope) || new Set();
    const explicit = [...grants].filter((grant) => grant === "app" || grant === "user").sort();
    if (grants.has("unknown") || explicit.length !== 1) {
      if (explicit.length > 1) scopeInstallGrants[scope] = explicit;
      continue;
    }
    scopeInstallGrant[scope] = explicit[0];
  }

  const merged = {
    identity,
    scopes,
    scopeInstallGrant,
  };
  if (Object.keys(scopeInstallGrants).length) merged.scopeInstallGrants = scopeInstallGrants;
  return merged;
}

export function collectLarkAuthFromSkillRoots(roots) {
  const declarations = [];
  const seen = new Set();
  for (const root of roots || []) {
    if (!root || !existsSync(root)) continue;
    for (const skillPath of buildSkillMap([root]).keys()) {
      const key = resolve(skillPath);
      if (seen.has(key)) continue;
      seen.add(key);
      const auth = readLarkAuth(skillPath);
      if (auth?.scopes?.length) declarations.push(auth);
    }
  }
  const auth = mergeLarkAuthDeclarations(declarations);
  if (!auth) return null;
  return {
    ...auth,
    skillCount: declarations.length,
  };
}

export function collectLarkAuthFromSkillRoot(root) {
  return collectLarkAuthFromSkillRoots(root ? [root] : []);
}

export function expandLarkAuthWithManagedSkills(currentAuth, options = {}) {
  const roots = Array.isArray(options.roots)
    ? options.roots
    : options.root !== undefined
      ? [options.root]
      : listOpenClawBundledSkillRoots({
        openclawHome: options.openclawHome,
        skillPath: options.skillPath,
      });
  const managed = options.managedAuth !== undefined
    ? options.managedAuth
    : collectLarkAuthFromSkillRoots(roots);
  const managedRoot = roots.map((root) => resolve(String(root || ""))).join(" | ");
  if (!managed?.scopes?.length) {
    return {
      auth: currentAuth,
      managedRoot,
      bundled: false,
      skillCount: 0,
    };
  }
  return {
    auth: mergeLarkAuthDeclarations([currentAuth, managed]),
    managedRoot,
    bundled: true,
    skillCount: Number(managed.skillCount || 0),
  };
}

function skillNameFromCandidate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const leaf = basename(normalized);
  if (leaf.toLowerCase() === "skill.md") {
    const parent = basename(dirname(normalized));
    return parent && parent !== "." ? parent : "";
  }
  if (normalized.includes("/")) return leaf;
  return raw;
}

function iterateSkillNameCandidates(skillNames) {
  if (skillNames == null) return [];
  const source = skillNames instanceof Map ? skillNames.values() : skillNames;
  if (typeof source === "string") return [source];
  if (typeof source?.[Symbol.iterator] === "function") return [...source];
  return [];
}

export function selectExplicitSkillNames(userText, skillNames) {
  const text = String(userText || "");
  if (!text.trim()) return [];
  const names = [...new Set(
    iterateSkillNameCandidates(skillNames)
      .map(skillNameFromCandidate)
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length);
  const matched = [];
  for (const skillName of names) {
    const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "u");
    if (pattern.test(text)) matched.push(skillName);
  }
  return matched;
}

export function isUserGrantWaiterDenial(waiter) {
  if (!waiter) return false;
  if (waiter.denied === true) return true;
  const output = String(waiter.output || "");
  if (/access_denied|authorization_denied|expired_token|oauth_denied/iu.test(output)) return true;
  return waiter.exited === true && waiter.exitCode != null && Number(waiter.exitCode) !== 0;
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

function extractEmbeddedOpenId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const match = normalized.match(/(?:^|:)(ou_[A-Za-z0-9]+)(?::|$)/);
  return match ? match[1] : null;
}

function pickFirstTrustedOpenId(values) {
  for (const value of values) {
    const target = normalizeAuthCardTarget(value);
    if (target?.receiveIdType === "open_id") return target.receiveId;
    const embedded = extractEmbeddedOpenId(value);
    if (embedded) return embedded;
  }
  return null;
}

export function collectTrustedSenderOpenIdSources(event, ctx) {
  return {
    ctxSenderId: ctx?.senderId ?? null,
    channelContextSenderId: ctx?.channelContext?.sender?.id ?? null,
    requesterSenderId: ctx?.requester?.senderId ?? null,
    ctxSenderOpenId: ctx?.senderOpenId ?? null,
    ctxOpenId: ctx?.openId ?? null,
    eventSenderId: event?.senderId ?? null,
    ctxSenderNestedOpenId:
      ctx?.sender?.sender_id?.open_id ??
      ctx?.sender?.senderId?.openId ??
      ctx?.sender?.open_id ??
      ctx?.sender?.id ??
      null,
    eventSenderNestedOpenId:
      event?.sender?.sender_id?.open_id ??
      event?.sender?.senderId?.openId ??
      event?.sender?.open_id ??
      event?.sender?.id ??
      event?.senderOpenId ??
      null,
    senderExternalId: ctx?.senderExternalId ?? null,
  };
}

export function extractTrustedSenderOpenId(event, ctx) {
  const sources = collectTrustedSenderOpenIdSources(event, ctx);
  const openId = pickFirstTrustedOpenId([
    sources.ctxSenderId,
    sources.channelContextSenderId,
    sources.requesterSenderId,
    sources.ctxSenderOpenId,
    sources.ctxOpenId,
    sources.eventSenderId,
    sources.ctxSenderNestedOpenId,
    sources.eventSenderNestedOpenId,
    sources.senderExternalId,
  ]);
  return { openId, sources };
}

export function summarizeSenderIdentityForLog(event, ctx) {
  const { openId, sources } = extractTrustedSenderOpenId(event, ctx);
  return {
    resolvedOpenId: openId,
    ...sources,
    channelContextKeys: ctx?.channelContext ? Object.keys(ctx.channelContext) : null,
    channelContextSenderKeys: ctx?.channelContext?.sender ? Object.keys(ctx.channelContext.sender) : null,
    requesterKeys: ctx?.requester ? Object.keys(ctx.requester) : null,
    ctxChatId: ctx?.chatId ?? ctx?.channelContext?.chat?.id ?? null,
  };
}

export function inferSenderIdFromCtx(ctx) {
  const fromTrusted = extractTrustedSenderOpenId(null, ctx).openId;
  if (fromTrusted) return fromTrusted;
  const fallbackCandidates = [ctx?.channelId, ctx?.sessionKey];
  for (const value of fallbackCandidates) {
    const target = normalizeAuthCardTarget(value);
    if (target?.receiveIdType === "open_id") return target.receiveId;
    const embedded = extractEmbeddedOpenId(value);
    if (embedded) return embedded;
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
  const trustedOpenId = extractTrustedSenderOpenId(null, ctx).openId;
  if (trustedOpenId) {
    return { receiveId: trustedOpenId, receiveIdType: "open_id" };
  }
  const cached = getCachedSenderId(ctx);
  if (cached) return { receiveId: cached, receiveIdType: "open_id" };
  for (const value of [process.env.OPENCLAW_SENDER_ID, process.env.SENDER_ID]) {
    const target = normalizeAuthCardTarget(value);
    if (target?.receiveIdType === "open_id") return target;
  }

  const chatIdCandidates = [
    ctx?.chatId,
    ctx?.channelContext?.chat?.id,
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

export function augmentCtxWithTrustedSender(ctx, event) {
  if (!ctx) return null;
  const { openId } = extractTrustedSenderOpenId(event, ctx);
  if (!openId) return null;
  if (!ctx.senderId) {
    try {
      ctx.senderId = openId;
    } catch {
      // Some hook contexts expose read-only views.
    }
  }
  return openId;
}

export function cacheTrustedSenderFromHook(event, ctx, sourceLabel = "hook") {
  const { openId, sources } = extractTrustedSenderOpenId(event, ctx);
  if (openId) {
    cacheSenderId(ctx, openId);
    augmentCtxWithTrustedSender(ctx, event);
    fileLog(
      `senderId: cached from ${sourceLabel} sessionId=${ctx?.sessionId || "<none>"} sessionKey=${ctx?.sessionKey || "<none>"} -> ${openId}`,
    );
    return openId;
  }
  fileLog(
    `senderId: unavailable from ${sourceLabel} sessionId=${ctx?.sessionId || "<none>"} sources=${JSON.stringify(sources)}`,
  );
  return null;
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
const larkCliBindingStateByAppId = new Map();

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
const LARK_CLI_BINDING_CACHE_TTL_MS = 5 * 60 * 1000;

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
  if (Array.isArray(profiles) && profiles.length === 0) {
    larkCliProfileByAppId.set(appId, { profile: null, resolvedAtMs: Date.now() });
    return { resolved: true, profile: null, source: "workspace-default" };
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

async function bindOpenClawProfile(profile, appId) {
  const bindArgs = [
    "config",
    "bind",
    "--source",
    "openclaw",
    "--app-id",
    String(appId || "").trim(),
    "--identity",
    "user-default",
  ];
  const result = await runLarkCli(bindArgs, { timeoutMs: 15000, profile });
  if (result?.ok || (result?.code === 0 && !result?.error)) return { ok: true };

  const detail = summarizeCommandResult(result);
  const needsForce = /\b--force\b|bot-only\s*[-=]?>\s*user-default|risky transition|user-default identity change/iu.test(detail);
  if (!needsForce) return { ok: false, error: detail };

  const forced = await runLarkCli([...bindArgs, "--force"], { timeoutMs: 15000, profile });
  if (forced?.ok || (forced?.code === 0 && !forced?.error)) return { ok: true, forced: true };
  return { ok: false, error: summarizeCommandResult(forced) };
}

export async function ensureLarkCliBindingReady(ctx = {}, options = {}) {
  const hasExplicitProfile = Object.prototype.hasOwnProperty.call(options, "profile");
  const explicitProfile = hasExplicitProfile ? String(options.profile || "").trim() || null : null;
  const health = await checkLarkCliRuntimeReady(explicitProfile);
  if (!health.ok) {
    return { ok: false, state: "blocked", reason: health.error, precondition: "lark-cli" };
  }

  const appId = await getAppId(ctx).catch(() => null);
  if (!appId) {
    return { ok: false, state: "blocked", reason: "OpenClaw Feishu appId unavailable", precondition: "openclaw-app-id" };
  }

  const configuredProfile = hasExplicitProfile ? explicitProfile : getConfiguredLarkCliProfile();
  const profileResolution = hasExplicitProfile
    ? { resolved: true, profile: explicitProfile, source: "explicit" }
    : configuredProfile
    ? { resolved: true, profile: configuredProfile, source: "env" }
    : await resolveLarkCliProfile(ctx);
  if (!profileResolution?.resolved) {
    return {
      ok: false,
      state: "blocked",
      reason: profileResolution?.error || `no lark-cli profile matches OpenClaw appId=${appId}; initialize local lark-cli app config before user authorization can start`,
      precondition: "lark-cli-profile",
    };
  }

  const profile = profileResolution.profile;
  const cached = larkCliBindingStateByAppId.get(appId);
  if (cached && cached.profile === profile && (Date.now() - cached.checkedAtMs) < LARK_CLI_BINDING_CACHE_TTL_MS) {
    return { ok: true, state: "ready", profile, appId, identity: "user-default" };
  }

  const bound = await bindOpenClawProfile(profile, appId);
  if (!bound.ok) {
    return {
      ok: false,
      state: "blocked",
      reason: `lark-cli config bind failed for profile=${profile} appId=${appId}: ${bound.error || "unknown error"}`,
      precondition: "lark-cli-bind",
      profile,
      appId,
    };
  }

  larkCliBindingStateByAppId.set(appId, { profile, checkedAtMs: Date.now() });
  return { ok: true, state: "healed", profile, appId, identity: "user-default" };
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const waiter = {
      started: true,
      pid: child.pid || null,
      exited: false,
      exitCode: null,
      signal: null,
      output: "",
      denied: false,
    };
    const appendOutput = (chunk) => {
      waiter.output = `${waiter.output}${chunk || ""}`.slice(-4000);
      if (/access_denied|authorization_denied|expired_token|oauth_denied/iu.test(waiter.output)) {
        waiter.denied = true;
      }
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.once("exit", (code, signal) => {
      waiter.exited = true;
      waiter.exitCode = code;
      waiter.signal = signal;
      if (isUserGrantWaiterDenial(waiter)) waiter.denied = true;
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

async function startUserGrantLogin(scopes, ctx = {}, options = {}) {
  const binding = await ensureLarkCliBindingReady(ctx, {
    ...(Object.prototype.hasOwnProperty.call(options, "larkProfile")
      ? { profile: options.larkProfile }
      : {}),
  });
  if (!binding.ok) {
    return {
      error: binding.reason || "lark-cli binding unavailable",
      precondition: binding.precondition || "lark-cli-bind",
    };
  }
  const result = await runLarkCli(
    ["auth", "login", "--scope", scopes.join(" "), "--no-wait", "--json"],
    { timeoutMs: 30000, profile: binding.profile },
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
  if (!verificationUrl || !deviceCode) return { error: summarizeCommandResult(result) };

  const waiter = spawnLarkCliDeviceWait(deviceCode, binding.profile);
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
    larkProfile: binding.profile,
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

export function retainGrantedTenantScopes(catalogEntries, grantScopes) {
  const grantedNames = new Set();
  for (const item of Array.isArray(grantScopes) ? grantScopes : []) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.scope_name || item.scope || "").trim();
    if (!name || Number(item.grant_status ?? item.grantStatus) !== 1) continue;
    grantedNames.add(name);
  }
  const retained = (Array.isArray(catalogEntries) ? catalogEntries : []).filter((entry) =>
    grantedNames.has(String(entry?.scope || "").trim()),
  );
  const known = new Set(retained.map((entry) => entry.scope));
  for (const name of grantedNames) {
    if (!known.has(name)) retained.push({ scope: name, identity: null, raw: null });
  }
  return retained;
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

export function scopeSatisfiesAppScope(scope, grantedSet, grantedList = [], options = {}) {
  const exactMatch = options.exactMatch !== false;
  const requested = String(scope || "").trim();
  if (!requested) return false;
  const normalizedGrantedSet = grantedSet instanceof Set
    ? grantedSet
    : new Set(Array.isArray(grantedList) ? grantedList.map((entry) => String(entry || "").trim()).filter(Boolean) : []);
  if (normalizedGrantedSet.has(requested)) return true;

  if (exactMatch) {
    return false;
  }

  const normalizedGrantedList = Array.isArray(grantedList)
    ? grantedList.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [...normalizedGrantedSet];

  const requestedPrefix = `${requested}:`;
  if (normalizedGrantedList.some((entry) => entry.startsWith(requestedPrefix))) {
    return true;
  }

  let prefix = requested;
  while (prefix.includes(":")) {
    prefix = prefix.slice(0, prefix.lastIndexOf(":"));
    if (normalizedGrantedSet.has(prefix)) return true;
  }

  return false;
}

function hasIdentityMetadata(entries) {
  return entries.some((entry) => entry.identity === "user" || entry.identity === "app");
}

function isAppInstallOnlyScopeName(scope) {
  const normalized = String(scope || "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("admin:")) return true;
  return false;
}

function appScopeEntriesMatchingScope(scope, appScopeEntries) {
  const requested = String(scope || "").trim();
  if (!requested || !Array.isArray(appScopeEntries)) return [];
  return appScopeEntries.filter((entry) => {
    const granted = String(entry?.scope || "").trim();
    if (!granted) return false;
    if (granted === requested) return true;
    return (
      scopeSatisfiesAppScope(requested, new Set([granted]), [granted]) ||
      scopeSatisfiesAppScope(granted, new Set([requested]), [requested])
    );
  });
}

function bucketsFromScopeInstallGrant(scope, scopeInstallGrant, scopeInstallGrants = null) {
  const multi = scopeInstallGrants?.[scope];
  if (Array.isArray(multi) && multi.length) {
    const buckets = [...new Set(multi.filter((grant) => grant === "app" || grant === "user"))];
    if (buckets.length) return buckets;
  }
  if (!scopeInstallGrant || typeof scopeInstallGrant !== "object") return null;
  const direct = scopeInstallGrant[scope];
  if (direct === "app" || direct === "user") return [direct];
  for (const [declared, grant] of Object.entries(scopeInstallGrant)) {
    if (grant !== "app" && grant !== "user") continue;
    if (
      declared === scope ||
      scopeSatisfiesAppScope(scope, new Set([declared]), [declared]) ||
      scopeSatisfiesAppScope(declared, new Set([scope]), [scope])
    ) {
      return [grant];
    }
  }
  return null;
}

export function resolveScopeAppInstallBuckets(scope, appScopeEntries, options = {}) {
  const requested = String(scope || "").trim();
  const skillIdentity = normalizeAuthIdentity(options.identity || "user");
  if (!requested) return ["any"];

  const grantBuckets = bucketsFromScopeInstallGrant(
    requested,
    options.scopeInstallGrant,
    options.scopeInstallGrants,
  );
  if (grantBuckets) return grantBuckets;

  if (!Array.isArray(appScopeEntries) || !hasIdentityMetadata(appScopeEntries)) {
    return skillIdentity === "app" ? ["app"] : ["user"];
  }

  const matches = appScopeEntriesMatchingScope(requested, appScopeEntries);
  const hasApp = matches.some((entry) => entry.identity === "app");
  const hasUser = matches.some((entry) => entry.identity === "user");

  if (hasApp && hasUser) return ["app", "user"];
  if (hasApp) return ["app"];
  if (hasUser) return ["user"];

  return skillIdentity === "app" ? ["app"] : ["user"];
}

function scopeListForInstallBucket(appScopeEntries, bucket) {
  return appScopeEntries
    .filter((entry) => entry.identity === bucket)
    .map((entry) => entry.scope)
    .filter(Boolean);
}

export function isScopeGrantedOnAppInstall(scope, appScopeEntries, options = {}) {
  const identity = normalizeAuthIdentity(options.identity || "user");
  const identityAware = hasIdentityMetadata(appScopeEntries);
  if (!identityAware) {
    const legacyList = appScopeEntries.map((entry) => entry.scope).filter(Boolean);
    return scopeSatisfiesAppScope(scope, new Set(legacyList), legacyList);
  }
  if (identity === "app") {
    const appList = scopeListForInstallBucket(appScopeEntries, "app");
    return scopeSatisfiesAppScope(scope, new Set(appList), appList);
  }

  const buckets = resolveScopeAppInstallBuckets(scope, appScopeEntries, {
    identity,
    scopeInstallGrant: options.scopeInstallGrant,
    scopeInstallGrants: options.scopeInstallGrants,
  });
  if (buckets.length === 1 && buckets[0] === "any") {
    const mergedList = appScopeEntries.map((entry) => entry.scope).filter(Boolean);
    return scopeSatisfiesAppScope(scope, new Set(mergedList), mergedList);
  }
  for (const bucket of buckets) {
    const bucketList = scopeListForInstallBucket(appScopeEntries, bucket);
    if (!scopeSatisfiesAppScope(scope, new Set(bucketList), bucketList)) {
      return false;
    }
  }
  return true;
}

export function filterScopesNeedingUserGrant(scopes, appScopeEntries, options = {}) {
  const scopeInstallGrant = options.scopeInstallGrant || null;
  const scopeInstallGrants = options.scopeInstallGrants || null;
  const list = uniqueScopes(scopes);
  if (!list.length) return [];
  return list.filter((scope) => {
    if (isAppInstallOnlyScopeName(scope)) return false;
    const grantBuckets = bucketsFromScopeInstallGrant(scope, scopeInstallGrant, scopeInstallGrants);
    if (grantBuckets?.length === 1 && grantBuckets[0] === "app") return false;
    if (grantBuckets?.includes("user")) return true;
    if (!Array.isArray(appScopeEntries) || !hasIdentityMetadata(appScopeEntries)) return true;
    const exactMatches = appScopeEntries.filter((entry) => entry.scope === scope);
    if (!exactMatches.length) return true;
    return exactMatches.some((entry) => entry.identity === "user");
  });
}

function filterScopesNeedingTenantGrant(missing, appScopeEntries, options = {}) {
  const scopeInstallGrant = options.scopeInstallGrant || null;
  const scopeInstallGrants = options.scopeInstallGrants || null;
  const list = uniqueScopes(missing);
  if (!list.length) return [];
  return list.filter((scope) => {
    const grantBuckets = bucketsFromScopeInstallGrant(scope, scopeInstallGrant, scopeInstallGrants);
    if (grantBuckets?.includes("app")) return true;
    if (grantBuckets?.length === 1 && grantBuckets[0] === "user") return false;
    if (!Array.isArray(appScopeEntries) || !hasIdentityMetadata(appScopeEntries)) {
      return true;
    }
    const appList = appScopeEntries
      .filter((entry) => entry.identity === "app")
      .map((entry) => entry.scope)
      .filter(Boolean);
    if (appList.length) {
      const appSet = new Set(appList);
      if (scopeSatisfiesAppScope(scope, appSet, appList)) return false;
    }
    const userList = appScopeEntries.filter((entry) => entry.identity === "user").map((entry) => entry.scope);
    const userSet = new Set(userList);
    if (isAppInstallOnlyScopeName(scope)) return true;
    return !scopeSatisfiesAppScope(scope, userSet, userList);
  });
}

function normalizeAccountId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed;
}

export function lookupAccountIdByAgentBinding(ctx) {
  const cfg = apiConfigRef;
  const agentId = resolveAgentId(ctx);
  if (!agentId || !cfg || !Array.isArray(cfg.bindings)) return null;
  const hit = cfg.bindings.find(
    (entry) =>
      entry?.agentId === agentId &&
      entry?.match?.channel === "feishu" &&
      typeof entry?.match?.accountId === "string" &&
      entry.match.accountId.trim(),
  );
  return hit ? normalizeAccountId(hit.match.accountId) : null;
}

function listFeishuAccountEntries() {
  const cfg = apiConfigRef;
  const feishuCfg = cfg?.channels?.feishu || {};
  const accounts =
    feishuCfg.accounts && typeof feishuCfg.accounts === "object"
      ? feishuCfg.accounts
      : {};
  return { feishuCfg, accounts };
}

export function findAccountIdByAppId(appId) {
  const needle = String(appId || "").trim();
  if (!needle) return null;
  const { accounts } = listFeishuAccountEntries();
  for (const [accountId, account] of Object.entries(accounts)) {
    if (String(account?.appId || "").trim() === needle) return normalizeAccountId(accountId);
  }
  return null;
}

function getSessionRecallKeys(ctx) {
  return [...new Set([ctx?.sessionKey, ctx?.sessionId].filter((value) => typeof value === "string" && value.trim()))];
}

export function recallResolvedCredentials(ctx) {
  for (const key of getSessionRecallKeys(ctx)) {
    const hit = resolvedCredentialsBySession.get(key);
    if (hit) return hit;
  }
  return null;
}

export function rememberResolvedCredentials(ctx, credentials) {
  if (!credentials?.accountId) return;
  for (const key of getSessionRecallKeys(ctx)) {
    resolvedCredentialsBySession.set(key, credentials);
    cachedAccountBySession.set(key, credentials.accountId);
  }
}

export function augmentCtxWithFeishuAccount(ctx, accountId) {
  const normalized = normalizeAccountId(accountId);
  if (!ctx || !normalized) return;
  try {
    ctx.accountId = normalized;
    ctx.account = normalized;
  } catch {}
  cacheAccountIdFromEventAndCtx({ accountId: normalized, account: normalized }, ctx);
}

function resolveAccountIdFromRouting(ctx) {
  const routingCtx = routingCtxWithAgent(ctx);
  const direct =
    normalizeAccountId(routingCtx?.accountId) ||
    normalizeAccountId(routingCtx?.account) ||
    normalizeAccountId(routingCtx?.channelAccountId) ||
    null;
  if (direct) return direct;
  for (const key of getSessionRecallKeys(routingCtx)) {
    if (cachedAccountBySession.has(key)) {
      return normalizeAccountId(cachedAccountBySession.get(key));
    }
  }
  const fromBinding = lookupAccountIdByAgentBinding(routingCtx);
  if (fromBinding) return fromBinding;
  return lookupAccountIdByAgentConvention(routingCtx);
}

function resolveRequestedAccountId(ctx) {
  const routed = resolveAccountIdFromRouting(ctx);
  if (routed) return routed;
  const recalled = recallResolvedCredentials(ctx);
  if (recalled?.accountId) return normalizeAccountId(recalled.accountId);
  const appIdHint =
    String(ctx?.appId || ctx?.feishuAppId || recalled?.appId || "").trim() || null;
  if (appIdHint) {
    const byAppId = findAccountIdByAppId(appIdHint);
    if (byAppId) return byAppId;
  }
  return null;
}

export function cacheAccountIdFromEventAndCtx(event, ctx) {
  const acc =
    normalizeAccountId(event?.accountId) ||
    normalizeAccountId(event?.account) ||
    normalizeAccountId(ctx?.accountId) ||
    normalizeAccountId(ctx?.account) ||
    normalizeAccountId(ctx?.channelAccountId) ||
    null;
  const agentId =
    normalizeAgentId(event?.agentId) ||
    normalizeAgentId(ctx?.agentId) ||
    null;
  const sid = ctx?.sessionId || event?.sessionId || null;
  const skey = ctx?.sessionKey || event?.sessionKey || null;
  const recallCtx = { sessionId: sid, sessionKey: skey };
  if (agentId) cacheAgentIdForSession(recallCtx, agentId);
  if (!acc) return null;
  if (sid) cachedAccountBySession.set(sid, acc);
  if (skey) cachedAccountBySession.set(skey, acc);
  return acc;
}

export function getAccountId(ctx) {
  const routingCtx = routingCtxWithAgent(ctx);
  const resolved = resolveAccountIdFromRouting(routingCtx);
  if (resolved) {
    const agentId = resolveAgentId(routingCtx);
    if (lookupAccountIdByAgentBinding(routingCtx) === resolved) {
      fileLog(`getAccountId: from bindings agentId=${agentId || "<none>"} -> ${resolved}`);
    } else if (lookupAccountIdByAgentConvention(routingCtx) === resolved) {
      fileLog(`getAccountId: from convention agentId=${agentId || "<none>"} -> ${resolved}`);
    } else {
      fileLog(`getAccountId: resolved=${resolved} agentId=${agentId || "<none>"}`);
    }
    if (ctx?.sessionId) cachedAccountBySession.set(ctx.sessionId, resolved);
    if (ctx?.sessionKey) cachedAccountBySession.set(ctx.sessionKey, resolved);
    return resolved;
  }
  fileLog(
    `getAccountId: MISS sessionId=${ctx?.sessionId || "<none>"} sessionKey=${ctx?.sessionKey || "<none>"} agentId=${resolveAgentId(ctx) || ctx?.agentId || "<none>"} cacheSize=${cachedAccountBySession.size}`,
  );
  return null;
}

/** 在 hook 入口统一缓存并补全 agentId / accountId（供多 hook 链路回溯） */
export function augmentHookRoutingContext(event, ctx) {
  if (!ctx) return;
  cacheAccountIdFromEventAndCtx(event, ctx);

  const agentFromHook =
    normalizeAgentId(event?.agentId) ||
    normalizeAgentId(ctx?.agentId) ||
    lookupAgentIdByWorkspace(ctx?.workspaceDir) ||
    resolveAgentId(ctx);
  if (agentFromHook) {
    cacheAgentIdForSession(ctx, agentFromHook);
    try {
      if (!ctx.agentId) ctx.agentId = agentFromHook;
    } catch {}
  }

  if (ctx?.workspaceDir) {
    if (ctx.sessionId) cachedWorkspaceBySession.set(ctx.sessionId, ctx.workspaceDir);
    if (ctx.sessionKey) cachedWorkspaceBySession.set(ctx.sessionKey, ctx.workspaceDir);
  }

  const accountId = getAccountId(ctx);
  if (accountId) {
    augmentCtxWithFeishuAccount(ctx, accountId);
  }
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

export async function resolveInstallAuthRecipient(ctx = {}, options = {}) {
  const accountId = getAccountId(ctx) || ctx?.accountId || ctx?.account || null;
  const appId = await getAppId(ctx).catch(() => null);
  if (!appId) {
    return { ok: false, reasonCode: "app_unresolved" };
  }

  const health = await checkLarkCliRuntimeReady();
  if (!health.ok) {
    return { ok: false, reasonCode: "runtime_unavailable", detail: health.error };
  }

  const listed = await runLarkCli(["profile", "list"], { timeoutMs: 10000, profile: null });
  const profiles = extractJsonArray(listed.stdout, listed.stderr);
  if (!listed?.ok || !Array.isArray(profiles)) {
    return { ok: false, reasonCode: "profile_list_unavailable" };
  }

  const requestedProfile = String(options.profile || "").trim() || null;
  const candidates = profiles
    .filter((profile) => getStatusString(profile?.appId || profile?.app_id) === getStatusString(appId))
    .map((profile) => String(profile?.name || "").trim())
    .filter(Boolean)
    .filter((profile) => !requestedProfile || profile === requestedProfile);
  if (requestedProfile && candidates.length === 0) {
    return { ok: false, reasonCode: "profile_unresolved" };
  }
  if (candidates.length === 0) {
    return { ok: false, reasonCode: "recipient_unavailable" };
  }

  const verified = [];
  const verifiedOtherUsers = [];
  const explicitOpenId = String(options.openId || "").trim() || null;
  for (const profile of candidates) {
    const result = await runLarkCli(["auth", "status", "--verify"], { timeoutMs: 30000, profile });
    const payload = extractJsonPayload(result.stdout, result.stderr);
    const user = payload?.identities?.user;
    const statusAppId = getStatusString(payload?.appId || payload?.app_id);
    const openId = getStatusString(user?.openId || user?.open_id);
    if (!result?.ok || statusAppId !== getStatusString(appId)) continue;
    if (user?.available !== true || user?.verified !== true || !openId) continue;
    const tuple = { profile, openId };
    if (!explicitOpenId || openId === explicitOpenId) verified.push(tuple);
    else verifiedOtherUsers.push(tuple);
  }

  if (verified.length === 1) {
    return {
      ok: true,
      accountId,
      appId,
      profile: verified[0].profile,
      openId: verified[0].openId,
      source: explicitOpenId ? "explicit-config" : "verified-profile",
    };
  }
  if (verified.length > 1) {
    return { ok: false, reasonCode: "recipient_ambiguous" };
  }
  if (explicitOpenId && verifiedOtherUsers.length > 0) {
    return { ok: false, reasonCode: "identity_mismatch" };
  }
  if (explicitOpenId && candidates.length === 1) {
    return {
      ok: true,
      accountId,
      appId,
      profile: candidates[0],
      openId: explicitOpenId,
      source: "explicit-config",
      bootstrap: true,
    };
  }
  return {
    ok: false,
    reasonCode: candidates.length > 1 ? "recipient_ambiguous" : "recipient_unavailable",
  };
}

export function getSkillAuthCacheKey(skillPath, ctx) {
  return `${getAccountId(ctx) || "unknown"}::${resolve(skillPath)}`;
}

/**
 * Multi-account fallback when hook ctx has no accountId after routing/cache/bindings.
 * 1) plugins.entries.openclaw-skill-runtime.config.defaultFeishuAccountId (explicit)
 * 2) accounts.default when agent is main or unknown (implicit; sub-agents must use bindings)
 */
export function resolveMultiAccountFallbackAccountId(ctx, configuredAccountIds) {
  const ids = Array.isArray(configuredAccountIds) ? configuredAccountIds : [];
  const explicit = pluginConfigRef?.defaultFeishuAccountId;
  if (typeof explicit === "string" && explicit.trim()) {
    const accountId = explicit.trim();
    if (ids.includes(accountId)) {
      return { accountId, source: "plugin-config" };
    }
  }
  const agentId = resolveAgentId(ctx) || normalizeAgentId(ctx?.agentId);
  if (agentId && agentId !== "main") {
    return null;
  }
  if (ids.includes("default")) {
    return { accountId: "default", source: "implicit-main-default" };
  }
  return null;
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
  const requestedAccountId = resolveRequestedAccountId(ctx);
  const configuredAccountIds = listConfiguredFeishuAccountIds(feishuCfg, accounts);

  let resolvedAccountId = requestedAccountId;
  let merged = {
    ...feishuCfg,
  };

  if (requestedAccountId) {
    resolvedAccountId = requestedAccountId;
    if (accounts[requestedAccountId]) {
      merged = mergeFeishuAccountLayer(feishuCfg, accounts[requestedAccountId]);
    } else if (requestedAccountId === "default") {
      merged = mergeFeishuAccountLayer(feishuCfg, accounts.default);
    } else if (!configuredAccountIds.includes(requestedAccountId)) {
      throw new Error(
        `feishu account unresolved: accountId=${requestedAccountId} not found among [${configuredAccountIds.join(", ")}]`,
      );
    }
  } else if (configuredAccountIds.length === 1) {
    resolvedAccountId = configuredAccountIds[0];
    merged = mergeFeishuAccountLayer(
      feishuCfg,
      resolvedAccountId === "default" ? accounts.default : accounts[resolvedAccountId],
    );
  } else if (configuredAccountIds.length > 1) {
    const fallback = resolveMultiAccountFallbackAccountId(ctx, configuredAccountIds);
    if (fallback?.accountId) {
      resolvedAccountId = fallback.accountId;
      merged = mergeFeishuAccountLayer(
        feishuCfg,
        resolvedAccountId === "default" ? accounts.default : accounts[resolvedAccountId],
      );
      if (fallback.source === "plugin-config") {
        fileLog(`getFeishuAccount: using config fallback accountId=${resolvedAccountId} (multi-account, ctx.accountId missing)`);
      } else {
        fileLog(`getFeishuAccount: using implicit default accountId=${resolvedAccountId} (multi-account, main or unknown agentId, ctx.accountId missing)`);
      }
    } else {
      throw new Error(
        `feishu account unresolved: ctx.accountId missing with multiple feishu accounts [${configuredAccountIds.join(", ")}]; Gateway must pass accountId on inbound messages, add bindings[].match.accountId for agentId=${resolveAgentId(ctx) || ctx?.agentId || "unknown"}, or set plugins.entries.openclaw-skill-runtime.config.defaultFeishuAccountId, or complete one successful scope grant in this session to bind appId=${String(ctx?.appId || recallResolvedCredentials(ctx)?.appId || "<unknown>")}`,
      );
    }
  } else if (feishuAccountLayerHasCredentials(feishuCfg)) {
    resolvedAccountId = "default";
    merged = mergeFeishuAccountLayer(feishuCfg, accounts.default);
  }

  if (!merged.appId || !merged.appSecret) {
    throw new Error(
      `feishu account unresolved: missing appId/appSecret for ${resolvedAccountId || "default"}`,
    );
  }

  const credentials = {
    accountId: resolvedAccountId || "default",
    appId: String(merged.appId),
    appSecret: String(merged.appSecret),
    brand: resolveFeishuBrand(merged.domain),
    domain: merged.domain ? String(merged.domain) : null,
  };
  rememberResolvedCredentials(ctx, credentials);
  augmentCtxWithFeishuAccount(ctx, credentials.accountId);
  return credentials;
}

export async function getAppId(ctx) {
  const credentials = await getAccountCredentials(ctx);
  return credentials.appId;
}

export function invalidateAppScopesCache(appId) {
  const aid = typeof appId === "string" ? appId.trim() : "";
  if (aid) appScopesCache.delete(aid);
}

export async function getAppScopeEntries(ctx, options = {}) {
  const credentials = await getAccountCredentials(ctx);
  const aid = credentials.appId;
  fileLog(
    `getAppScopes: resolved appId=${aid || "<empty>"} accountId=${credentials.accountId}${options.forceRefresh ? " forceRefresh" : ""}`,
  );
  const forceRefresh = options.forceRefresh === true;
  if (forceRefresh) {
    invalidateAppScopesCache(aid);
  }
  const cached = appScopesCache.get(aid);
  const now = Date.now();
  if (!forceRefresh && cached?.entries && cached.expiresAt > now) {
    return cached.entries;
  }
  if (!forceRefresh && cached?.promise) {
    return cached.promise;
  }

  const combinedPromise = Promise.all([
    callFeishuOpenApi(credentials, {
      method: "GET",
      path: `/open-apis/application/v6/applications/${aid}`,
      params: { lang: "zh_cn" },
    }),
    callFeishuOpenApi(credentials, {
      method: "GET",
      path: "/open-apis/application/v6/scopes",
    }),
  ])
    .then(([appResponse, grantResponse]) => {
      if (!grantResponse || grantResponse.code !== 0 || !Array.isArray(grantResponse?.data?.scopes)) {
        fileLog(
          `getAppScopes: tenant grant status failed: ${grantResponse?.msg || grantResponse?.message || "unparseable"}`,
        );
        return null;
      }
      const catalog = appResponse?.code === 0 && Array.isArray(appResponse?.data?.app?.scopes)
        ? normalizeAppScopeEntries(appResponse.data.app.scopes)
        : [];
      if (appResponse?.code !== 0) {
        fileLog(
          `getAppScopes: application catalog failed, using granted scope names only: ${appResponse?.msg || appResponse?.message || "unparseable"}`,
        );
      }
      const entries = retainGrantedTenantScopes(catalog, grantResponse.data.scopes);
      const revoked = grantResponse.data.scopes
        .map((item) => String(item?.scope_name || item?.scope || "").trim())
        .filter((name) => name && !entries.some((entry) => entry.scope === name));
      fileLog(
        `getAppScopes: tenant grants granted=${entries.length} revoked=${revoked.length}${revoked.length ? ` revokedScopes=${JSON.stringify(revoked)}` : ""}`,
      );
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
  const appScopeEntries = options.appScopeEntries ?? (await getAppScopeEntries(ctx));
  if (!appScopeEntries) {
    fileLog(`checkScopes: getAppScopes failed, falling back to all missing`);
    return { ok: false, missing: scopes, granted: [], identity };
  }

  const identityAware = hasIdentityMetadata(appScopeEntries);
  const granted = [];
  const missing = [];
  const bucketHints = [];

  const scopeInstallGrant = options.scopeInstallGrant || null;
  const scopeInstallGrants = options.scopeInstallGrants || null;
  for (const scope of scopes) {
    const checkOptions = { identity, scopeInstallGrant, scopeInstallGrants };
    const buckets = identityAware
      ? resolveScopeAppInstallBuckets(scope, appScopeEntries, checkOptions)
      : ["any"];
    const hasScope = isScopeGrantedOnAppInstall(scope, appScopeEntries, checkOptions);
    if (hasScope) {
      granted.push(scope);
    } else {
      missing.push(scope);
      if (identityAware && buckets[0] !== "any") {
        bucketHints.push(`${scope}→${buckets.join("+")}`);
      }
    }
  }

  if (!identityAware) {
    fileLog(`checkScopes: scope identity metadata unavailable; using legacy scope-string match for identity=${identity}`);
  }
  fileLog(
    `checkScopes: appScopes=${appScopeEntries.length}, identity=${identity}, identityAware=${identityAware}, bucketHints=${JSON.stringify(bucketHints)}, missing=${JSON.stringify(missing)}, granted=${JSON.stringify(granted)}`,
  );
  return { ok: missing.length === 0, missing, granted, identity, identityAware };
}
export function buildScopeGrantLoginPayload(missing, options = {}) {
  const authReason = String(options.authReason || "app_scope").trim();
  const identity = normalizeAuthIdentity(options.identity);
  const payload = {
    authReason,
    identity,
    scopeGrantDual: false,
    tenantScopes: null,
    userScopes: null,
  };
  if (authReason === "user_grant") return payload;
  if (identity === "user") {
    const requiredScopes = uniqueScopes(options.requiredScopes || missing);
    const scopeInstallGrant = options.scopeInstallGrant || null;
    const scopeInstallGrants = options.scopeInstallGrants || null;
    const appScopeEntries = options.appScopeEntries;
    const grantOptions = { scopeInstallGrant, scopeInstallGrants };
    const tenantMissing = filterScopesNeedingTenantGrant(
      uniqueScopes(missing),
      appScopeEntries,
      grantOptions,
    );
    const userScopesForGrant = filterScopesNeedingUserGrant(
      requiredScopes,
      appScopeEntries,
      grantOptions,
    );
    payload.tenantScopes = tenantMissing.length ? tenantMissing : null;
    payload.userScopes = userScopesForGrant.length ? userScopesForGrant : null;
    payload.scopeGrantDual = Boolean(payload.tenantScopes?.length && payload.userScopes?.length);
  }
  return payload;
}

export function listSubmittedGrantScopes(missing, options = {}) {
  const authReason = String(options.authReason || "app_scope").trim();
  const identity = normalizeAuthIdentity(options.identity);
  const grantOptions = {
    scopeInstallGrant: options.scopeInstallGrant || null,
    scopeInstallGrants: options.scopeInstallGrants || null,
  };
  if (authReason === "user_grant") {
    const userScopes = filterScopesNeedingUserGrant(
      uniqueScopes(options.requiredScopes || missing),
      options.appScopeEntries,
      grantOptions,
    );
    return {
      tenantScopes: [],
      userScopes,
      requestedScopes: userScopes,
      scopeGrantDual: false,
    };
  }
  if (identity === "user") {
    const grant = buildScopeGrantLoginPayload(missing, options);
    const tenantScopes = grant.tenantScopes || [];
    const userScopes = grant.userScopes || [];
    const requestedScopes = uniqueScopes([...tenantScopes, ...userScopes]);
    return {
      tenantScopes,
      userScopes,
      requestedScopes: requestedScopes.length ? requestedScopes : uniqueScopes(missing),
      scopeGrantDual: grant.scopeGrantDual === true,
    };
  }
  const requestedScopes = uniqueScopes(missing);
  return {
    tenantScopes: requestedScopes,
    userScopes: [],
    requestedScopes,
    scopeGrantDual: false,
  };
}

function uniqueScopes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((scope) => String(scope).trim()).filter(Boolean))];
}

export async function startLogin(missing, ctx, options = {}) {
  if (!missing?.length && !options.requiredScopes?.length) return { error: "no scopes" };
  try {
    const appScopeEntries =
      options.appScopeEntries ?? (await getAppScopeEntries(ctx).catch(() => null));
    const submitted = listSubmittedGrantScopes(missing, { ...options, appScopeEntries });
    const grant = buildScopeGrantLoginPayload(missing, { ...options, appScopeEntries });
    if (grant.authReason === "user_grant") {
      if (!submitted.requestedScopes.length) return { error: "no scopes" };
      const login = await startUserGrantLogin(submitted.requestedScopes, ctx, options);
      if (!login?.verificationUrl) return login;
      return {
        ...login,
        requestedScopes: submitted.requestedScopes,
        scopeGrantDual: false,
      };
    }
    const credentials = await getAccountCredentials(ctx);
    const flow = await beginScopeGrantFlow({
      appId: credentials.appId,
      brand: credentials.brand,
      scopes: uniqueScopes(missing),
      identity: grant.identity,
      tenantScopes: grant.tenantScopes,
      userScopes: grant.userScopes,
      scopeInstallGrant: options.scopeInstallGrant || null,
      scopeInstallGrants: options.scopeInstallGrants || null,
    });
    if (grant.scopeGrantDual) {
      fileLog(
        `startLogin: dual scope grant tenant=${JSON.stringify(grant.tenantScopes)} user=${JSON.stringify(grant.userScopes)}`,
      );
    }
    return {
      ...flow,
      scopeGrantDual: grant.scopeGrantDual,
      requestedScopes: submitted.requestedScopes,
    };
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
  ].map(getStatusString).filter(Boolean).join("\n");
  return errorCode === "20005" || /\[20005\]/u.test(message) || /\bneed_user_authorization\b/iu.test(message);
}

function isReauthRequiredLarkCliStatus(payload, expectedAppId, openId) {
  const userIdentity = payload?.identities?.user;
  const status = getStatusString(userIdentity?.status).toLowerCase();
  const appMatches = Boolean(expectedAppId) &&
    getStatusString(payload?.appId || payload?.app_id) === getStatusString(expectedAppId);
  const requesterMatches = Boolean(openId) && (
    getStatusString(userIdentity?.openId || userIdentity?.open_id) === getStatusString(openId) ||
    (status === "missing" && userIdentity?.available === false && !getStatusString(userIdentity?.openId || userIdentity?.open_id))
  );
  if (!appMatches || !requesterMatches) return false;
  return (status === "missing" && userIdentity?.available === false) ||
    isExplicitInvalidAccessTokenStatus(payload, userIdentity);
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
  let expectedAppId = await getAppId(ctx).catch(() => null);
  if (!expectedAppId) {
    expectedAppId = recallResolvedCredentials(ctx)?.appId || null;
  }
  const hasExplicitProfile = Object.prototype.hasOwnProperty.call(options, "larkProfile");
  const explicitProfile = hasExplicitProfile ? String(options.larkProfile || "").trim() || null : null;
  const configuredProfile = hasExplicitProfile ? explicitProfile : getConfiguredLarkCliProfile();
  const cachedProfile = !hasExplicitProfile && !configuredProfile && expectedAppId
    ? larkCliProfileByAppId.get(expectedAppId)
    : null;
  let profile = configuredProfile || cachedProfile?.profile || null;
  let result = await runLarkCli(["auth", "status", "--verify"], { timeoutMs: 30000, profile });
  let payload = extractJsonPayload(result.stdout, result.stderr);
  let userIdentity = payload?.identities?.user;
  const defaultProfileMatchesApp = !hasExplicitProfile && !configuredProfile &&
    getStatusString(payload?.appId || payload?.app_id) === getStatusString(expectedAppId);
  if (defaultProfileMatchesApp && expectedAppId) {
    larkCliProfileByAppId.set(expectedAppId, { profile: null, resolvedAtMs: Date.now() });
  }
  if (!hasExplicitProfile && !configuredProfile && !profile && !defaultProfileMatchesApp) {
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
  if (isReauthRequiredLarkCliStatus(payload, expectedAppId, openId)) {
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
  const statusMatchesRequester = commandSucceeded &&
    Boolean(expectedAppId) &&
    getStatusString(payload?.appId || payload?.app_id) === getStatusString(expectedAppId) &&
    getStatusString(userIdentity?.openId || userIdentity?.open_id) === getStatusString(openId) &&
    userIdentity?.available === true &&
    userIdentity?.verified === true;
  if (statusMatchesRequester) {
    const normalized = normalizeGrantCheckResult(
      { scope: userIdentity.scope || userIdentity.scopes || [] },
      scopes,
      options,
    );
    if (normalized) {
      const verified = {
        ...normalized,
        source: "lark-cli-status",
        oauthState: normalized.ok ? "authorized" : "scope_missing",
      };
      fileLog(`checkUserGrant result ${formatGrantCheckForLog(verified, options)}`);
      return verified;
    }
  }

  const payloadAppId = getStatusString(payload?.appId || payload?.app_id);
  const userStatus = getStatusString(userIdentity?.status).toLowerCase();
  if (
    commandSucceeded &&
    payloadAppId &&
    (!expectedAppId || payloadAppId === getStatusString(expectedAppId)) &&
    userStatus === "missing" &&
    userIdentity?.available === false
  ) {
    if (!expectedAppId) {
      expectedAppId = payloadAppId;
      const accountId = findAccountIdByAppId(payloadAppId);
      if (accountId) augmentCtxWithFeishuAccount(ctx, accountId);
    }
    const reauthRequired = {
      ok: false,
      missing: scopes,
      granted: [],
      source: "lark-cli-status",
      oauthState: "oauth_reauth_required",
      reason: "User identity: missing (no user logged in)",
    };
    fileLog(`checkUserGrant result ${formatGrantCheckForLog(reauthRequired, options)}`);
    return reauthRequired;
  }

  const unavailable = {
    ok: false,
    missing: scopes,
    granted: [],
    unavailable: true,
    source: "lark-cli",
    oauthState: "oauth_runtime_unavailable",
    reason: summarizeCommandResult(result),
  };
  fileLog(`checkUserGrant result ${formatGrantCheckForLog(unavailable, options)}`);
  return unavailable;
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

export async function ensureFeishuRuntimeHealth(ctx) {
  const cacheKey =
    resolveRequestedAccountId(ctx || {}) ||
    recallResolvedCredentials(ctx || {})?.accountId ||
    ctx?.sessionKey ||
    ctx?.sessionId ||
    "default";
  if (runtimeHealthCacheByKey.has(cacheKey)) {
    return runtimeHealthCacheByKey.get(cacheKey);
  }
  const pending = getAccountCredentials(ctx || {})
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
      runtimeHealthCacheByKey.set(cacheKey, info);
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
          "请在 api.config.channels.feishu 或 channels.feishu.accounts 中配置可用的 appId/appSecret，并确保入站消息携带 accountId（多账号场景可在 bindings 中绑定 agentId）。",
      };
      fileLog(`runtime: feishu sdk unavailable error=${info.error}`);
      runtimeHealthCacheByKey.set(cacheKey, info);
      return info;
    });
  runtimeHealthCacheByKey.set(cacheKey, pending);
  return pending;
}

export function sidebarApplink(authUrl) {
  const q = encodeURIComponent(authUrl);
  return `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${q}`;
}

/** 按 skillName 去重的轮询定时器，防止同一技能创建多个轮询 */
const activePollingIntervals = new Map();

export function isAuthPollingActive(pollingKey) {
  if (!pollingKey) return false;
  const entry = activePollingIntervals.get(pollingKey);
  return Boolean(entry?.active);
}

export function isAuthPollingActiveForTarget({ authTargetKey, skillName } = {}) {
  if (isAuthPollingActive(authTargetKey)) return true;
  if (skillName && isAuthPollingActive(skillName)) return true;
  return false;
}

export function getAuthPollingSnapshot(pollingKey) {
  if (!pollingKey) return null;
  const entry = activePollingIntervals.get(pollingKey);
  if (!entry?.active) return null;
  return {
    active: true,
    lastPollAtMs: Number(entry.lastPollAtMs || 0),
    hasInterval: Boolean(entry.interval),
    pollInFlight: entry.pollInFlight === true,
    startedAtMs: Number(entry.startedAtMs || 0),
  };
}

async function withAsyncTimeout(promise, timeoutMs, label) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clearActivePollingIntervals() {
  for (const entry of activePollingIntervals.values()) {
    if (entry?.interval) clearInterval(entry.interval);
    entry.active = false;
    cancelAuthWaiter(entry?.authWaiter);
  }
  activePollingIntervals.clear();
}

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

async function sendTextMessage(receiveId, receiveIdType, text, ctx = {}) {
  if (!receiveId) return { error: "no receiveId" };
  const payload = JSON.stringify({ text: String(text || "").slice(0, 4000) });
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "send",
        receive_id: receiveId,
        receive_id_type: receiveIdType,
        msg_type: "text",
        content: payload,
      });
      const messageId =
        response?.data?.message_id ||
        response?.message_id ||
        response?.id ||
        (response?.success ? "sent" : null);
      if (messageId) return { messageId };
      return { error: formatFeishuApiResponseError(response) };
    } catch (error) {
      return { error: formatError(error) };
    }
  }
  const credentials = await getAccountCredentials(ctx);
  try {
    const response = await callFeishuOpenApi(credentials, {
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: receiveIdType },
      body: {
        receive_id: receiveId,
        msg_type: "text",
        content: payload,
      },
    });
    const messageId = response?.data?.message_id || null;
    if (messageId) return { messageId };
    return { error: formatFeishuApiResponseError(response) };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function sendImFileMessage(receiveId, receiveIdType, fileKey, ctx = {}) {
  if (!receiveId) return { error: "no receiveId" };
  const content = JSON.stringify({ file_key: fileKey });
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "send",
        receive_id: receiveId,
        receive_id_type: receiveIdType,
        msg_type: "file",
        content,
      });
      const messageId =
        response?.data?.message_id ||
        response?.message_id ||
        response?.id ||
        (response?.success ? "sent" : null);
      if (messageId) return { messageId };
      return { error: formatFeishuApiResponseError(response) };
    } catch (error) {
      return { error: formatError(error) };
    }
  }
  const credentials = await getAccountCredentials(ctx);
  try {
    const response = await callFeishuOpenApi(credentials, {
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: receiveIdType },
      body: {
        receive_id: receiveId,
        msg_type: "file",
        content,
      },
    });
    const messageId = response?.data?.message_id || null;
    if (messageId) return { messageId };
    return { error: formatFeishuApiResponseError(response) };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function replyImFileMessage(cardMessageId, fileKey, ctx = {}) {
  const mid = String(cardMessageId || "").trim();
  if (!mid || mid === "sent") return { error: "no messageId" };
  const content = JSON.stringify({ file_key: fileKey });
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "reply",
        message_id: mid,
        msg_type: "file",
        content,
      });
      const messageId =
        response?.data?.message_id ||
        response?.message_id ||
        response?.id ||
        (isFeishuMutationSuccessful(response) ? "sent" : null);
      if (messageId) return { messageId };
      return { error: formatFeishuApiResponseError(response) };
    } catch (error) {
      return { error: formatError(error) };
    }
  }
  try {
    const response = await callFeishuOpenApi(await getAccountCredentials(ctx), {
      method: "POST",
      path: `/open-apis/im/v1/messages/${encodeURIComponent(mid)}/reply`,
      body: { msg_type: "file", content },
    });
    const messageId = response?.data?.message_id || null;
    if (messageId) return { messageId };
    return { error: formatFeishuApiResponseError(response) };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function deliverAuthDiagnosticDownload({
  document,
  fileName,
  openId = null,
  cardMessageId = null,
  ctx = {},
}) {
  const text = String(document || "");
  if (!text.trim()) {
    return { delivery: "skipped", error: "empty document" };
  }
  const credentials = await getAccountCredentials(ctx).catch((error) => ({
    error: error?.message || String(error),
  }));
  if (!credentials?.appId || credentials.error) {
    return {
      delivery: "failed",
      error: credentials?.error || "no feishu credentials",
    };
  }
  let fileKey;
  try {
    fileKey = await uploadImFile(credentials, { fileName, content: text });
  } catch (error) {
    return { delivery: "failed", error: error?.message || String(error) };
  }
  if (cardMessageId && cardMessageId !== "sent") {
    const replied = await replyImFileMessage(cardMessageId, fileKey, ctx);
    if (replied?.messageId) {
      fileLog(`auth diagnostic file replied skill file=${fileName} cardMsg=${cardMessageId}`);
      return { delivery: "replied", fileName, fileKey, fileMessageId: replied.messageId };
    }
    fileLog(`auth diagnostic file reply failed: ${replied?.error || "unknown"}; try direct send`);
  }
  if (openId) {
    const sent = await sendImFileMessage(openId, "open_id", fileKey, ctx);
    if (sent?.messageId) {
      fileLog(`auth diagnostic file sent skill file=${fileName} openId=<present>`);
      return { delivery: "sent", fileName, fileKey, fileMessageId: sent.messageId };
    }
    return { delivery: "failed", error: sent?.error || "file message send failed" };
  }
  return { delivery: "failed", error: "no openId or card message to deliver file" };
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

function buildAuthStageDoneCard({
  skillName,
  authReason = "app_scope",
  userGrantComplete = false,
  needsUserGrantStep = false,
}) {
  const isUserGrant = authReason === "user_grant";
  let title;
  let subtitle;
  let content;
  let statusText;
  if (isUserGrant) {
    title = "飞书用户授权已完成";
    subtitle = `技能 “${skillName}” 已完成用户身份授权`;
    content = `技能 **${skillName}** 的用户授权已完成。`;
    statusText = "<font color='green'>✅ 用户授权完成</font>";
  } else if (userGrantComplete) {
    title = "飞书应用权限已开通";
    subtitle = `技能 “${skillName}” 已完成应用权限开通和用户授权`;
    content = `技能 **${skillName}** 的应用权限已开通，当前用户授权也已完成。`;
    statusText = "<font color='green'>✅ 应用权限开通完成，用户授权已完成</font>";
  } else if (needsUserGrantStep) {
    title = "飞书应用权限已开通";
    subtitle = `技能 “${skillName}” 应用侧已就绪（不应停在此状态）`;
    content = `技能 **${skillName}** 应用侧权限已确认，但用户 OAuth 尚未完成。若未看到「(2/2) 用户登录授权」按钮，请**重新执行该技能**以获取登录卡片。`;
    statusText = "<font color='orange'>⏳ 等待第 2 步用户登录</font>";
  } else {
    title = "飞书应用权限已开通";
    subtitle = `技能 “${skillName}” 已完成应用权限开通`;
    content = `技能 **${skillName}** 的应用权限已开通。请**重新执行该技能**继续任务。`;
    statusText = "<font color='green'>✅ 应用权限开通完成</font>";
  }
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

function buildAuthStageFailureCard({
  skillName,
  state,
  authReason = "user_grant",
  userSummary = null,
  cardHint = null,
}) {
  const timedOut = state === "timeout";
  const denied = state === "denied";
  const runtimeUnavailable = state === "oauth_runtime_unavailable";
  const appScope = authReason === "app_scope";
  const subject = appScope ? "飞书应用权限开通" : "飞书用户授权";
  const title = denied
    ? `${subject}已拒绝`
    : runtimeUnavailable
    ? "飞书用户授权运行时不可用"
    : timedOut ? `${subject}超时` : "飞书用户授权未完成";
  const subtitle = denied
    ? `技能 “${skillName}” 的${appScope ? "应用权限开通" : "用户授权"}已拒绝，技能已停止`
    : runtimeUnavailable
    ? `技能 “${skillName}” 的用户授权运行时当前不可用`
    : timedOut
      ? `技能 “${skillName}” 的${appScope ? "应用权限开通" : "用户授权"}已超时`
      : `技能 “${skillName}” 的用户授权已取消或未完成`;
  const fallbackContent = denied
    ? "你已拒绝本次授权，技能已停止。如需继续，请重新触发该技能。"
    : runtimeUnavailable
    ? "授权运行时当前不可用，请检查 OAuth 运行时后重试。"
    : timedOut
      ? `${appScope ? "应用权限开通" : "授权"}超时，请重新触发技能后再次授权。`
      : "授权被取消或未成功完成，请重新触发技能后再次授权。";
  const content = userSummary || fallbackContent;
  const statusText = denied
    ? "<font color='red'>✖ 授权已拒绝，技能已停止</font>"
    : timedOut
    ? "<font color='orange'>⏱ 授权超时</font>"
    : runtimeUnavailable
      ? "<font color='red'>✖ 授权运行时不可用</font>"
    : "<font color='red'>✖ 授权未完成</font>";
  const elements = [
    { tag: "markdown", content: `技能 **${skillName}**\n\n**原因：** ${content}` },
  ];
  if (cardHint) {
    elements.push({
      tag: "markdown",
      content: cardHint,
    });
  }
  elements.push({
    tag: "markdown",
    content: `<font color='grey'>插件 build: ${PLUGIN_RUNTIME_BUILD}</font>`,
  });
  elements.push({
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
  });
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
    body: { elements },
  };
}

async function updateAuthStageCard({
  messageId,
  skillName,
  authReason,
  accountId,
  userGrantComplete = false,
  needsUserGrantStep = false,
}) {
  if (!messageId || messageId === "sent") return { error: "no messageId" };
  const result = await updateInteractiveCard(
    messageId,
    buildAuthStageDoneCard({ skillName, authReason, userGrantComplete, needsUserGrantStep }),
    { accountId },
  );
  if (result?.messageId) {
    fileLog(
      `auth card updated skill="${skillName}" authReason=${authReason} userGrantComplete=${userGrantComplete} needsUserGrantStep=${needsUserGrantStep} msg=${messageId}`,
    );
  } else if (result?.error) {
    fileLog(`auth card update failed skill="${skillName}" authReason=${authReason}: ${result.error}`);
  }
  return result;
}

export async function finalizeAuthStageCard(params) {
  return updateAuthStageCard(params);
}

async function reportAuthStageFailure({
  messageId,
  skillName,
  accountId,
  state,
  authReason,
  authTargetKey = null,
  waitCtx = null,
  openId = null,
  timeline = [],
  check = null,
  registration = null,
  authWaiter = null,
  graceElapsedSec = null,
  elapsedSec = null,
}) {
  const oauthState = check?.oauthState || null;
  const registrationError = registration?.error || null;
  const diagnosticPayload = {
    skillName,
    authTargetKey,
    state,
    authReason,
    build: PLUGIN_RUNTIME_BUILD,
    accountId: accountId || waitCtx?.accountId || waitCtx?.account || null,
    appId: waitCtx?.appId || waitCtx?.feishuAppId || null,
    openId: openId || null,
    oauthState,
    reason: check?.reason || null,
    source: check?.source || null,
    missingScopes: check?.missing,
    registrationStatus: registration?.status || null,
    registrationError,
    waiterExitCode: authWaiter?.exitCode ?? null,
    waiterSignal: authWaiter?.signal ?? null,
    graceElapsedSec,
    elapsedSec,
    timeline,
    lastCheckJson: check ? formatGrantCheckForLog(check, {}) : null,
  };
  const document = buildDiagnosticDocument(diagnosticPayload);
  let diagnosticFilePath = null;
  let diagnosticFileName = null;
  try {
    const written = writeAuthDiagnosticFile({
      document,
      authTargetKey,
      skillName,
    });
    diagnosticFilePath = written.path;
    diagnosticFileName = written.fileName;
    fileLog(
      `auth diagnostic written skill="${skillName}" file=${diagnosticFileName} path=${diagnosticFilePath}`,
    );
  } catch (error) {
    fileLog(`auth diagnostic write failed skill="${skillName}": ${error?.message || error}`);
  }
  const userSummary = formatUserFacingFailureSummary({
    state,
    authReason,
    oauthState,
    reason: check?.reason,
    registrationError,
    missingScopes: check?.missing,
    source: check?.source,
    waiterExitCode: authWaiter?.exitCode,
    graceElapsedSec,
    elapsedSec,
  });
  const cardHint = formatCardFailureHint({
    state,
    oauthState,
    registrationError,
  });
  // 失败发送诊断日志（飞书 IM）：默认关闭，见 AUTH_FAILURE_DIAGNOSTIC_SEND_ENABLED
  if (AUTH_FAILURE_DIAGNOSTIC_SEND_ENABLED) {
    const downloadResult = await deliverAuthDiagnosticDownload({
      document,
      fileName: diagnosticFileName || `${skillName || "skill"}-auth-diagnostic.log`,
      openId,
      cardMessageId: messageId,
      ctx: { accountId: accountId || waitCtx?.accountId || waitCtx?.account, ...waitCtx },
    }).catch((error) => ({
      delivery: "failed",
      error: error?.message || String(error),
    }));
    const diagnosticDelivery = downloadResult?.delivery || "failed";
    const diagnosticDeliveryError = downloadResult?.error || null;
    if (diagnosticDelivery === "failed" && diagnosticDeliveryError) {
      fileLog(`auth diagnostic file delivery failed skill="${skillName}": ${diagnosticDeliveryError}`);
    }
    const notifyText = [
      `[openclaw-skill-runtime] 授权失败诊断 build=${PLUGIN_RUNTIME_BUILD}`,
      `技能: ${skillName}`,
      `状态: ${state}`,
      `原因: ${userSummary}`,
      diagnosticDelivery === "replied" || diagnosticDelivery === "sent"
        ? `诊断日志文件: ${diagnosticFileName || "auth-diagnostic.log"}（已在飞书对话中发送，请下载）`
        : diagnosticFilePath
          ? `Gateway 诊断文件: ${diagnosticFilePath}`
          : "（诊断文件未写入，请查 Gateway 日志 auth diagnostic write failed）",
    ].join("\n");
    if (openId) {
      const textSent = await sendTextMessage(openId, "open_id", notifyText, {
        accountId: accountId || waitCtx?.accountId || waitCtx?.account,
      }).catch((error) => ({ error: error?.message || String(error) }));
      if (textSent?.messageId) {
        fileLog(`auth diagnostic text sent skill="${skillName}" msg=${textSent.messageId}`);
      } else if (textSent?.error) {
        fileLog(`auth diagnostic text failed skill="${skillName}": ${textSent.error}`);
      }
    }
  } else {
    fileLog(
      `auth diagnostic send disabled skill="${skillName}" localPath=${diagnosticFilePath || "<none>"}`,
    );
  }
  if (!messageId || messageId === "sent") {
    fileLog(
      `auth failure diagnostic-only skill="${skillName}" file=${diagnosticFileName || "<none>"} path=${diagnosticFilePath || "<none>"}`,
    );
    return { error: "no messageId", diagnosticFilePath, diagnosticFileName };
  }
  return updateAuthFailureCard({
    messageId,
    skillName,
    accountId,
    state,
    authReason,
    userSummary,
    cardHint,
  });
}

async function updateAuthFailureCard({
  messageId,
  skillName,
  accountId,
  state,
  authReason,
  userSummary = null,
  cardHint = null,
}) {
  if (!messageId || messageId === "sent") return { error: "no messageId" };
  const fullCard = buildAuthStageFailureCard({
    skillName,
    state,
    authReason,
    userSummary,
    cardHint,
  });
  let result = await updateInteractiveCard(messageId, fullCard, { accountId });
  if (result?.messageId) {
    fileLog(`auth card updated skill="${skillName}" state=${state} msg=${messageId} variant=full`);
    return result;
  }
  fileLog(
    `auth card failure update failed skill="${skillName}" state=${state} variant=full err=${result?.error || "unknown"}; retry compact`,
  );
  const compactCard = buildAuthStageFailureCard({
    skillName,
    state,
    authReason,
    userSummary,
    cardHint,
  });
  result = await updateInteractiveCard(messageId, compactCard, { accountId });
  if (result?.messageId) {
    fileLog(`auth card updated skill="${skillName}" state=${state} msg=${messageId} variant=compact`);
  } else if (result?.error) {
    fileLog(
      `auth card failure update failed skill="${skillName}" state=${state} variant=compact err=${result.error}`,
    );
  }
  return result;
}

function buildAuthWaitContext(ctx = {}) {
  const recalled = recallResolvedCredentials(ctx);
  const accountId = getAccountId(ctx) || recalled?.accountId || null;
  const appId = String(ctx?.appId || ctx?.feishuAppId || recalled?.appId || "").trim() || null;
  return {
    ...ctx,
    ...(accountId ? { accountId, account: accountId } : {}),
    ...(appId ? { appId, feishuAppId: appId } : {}),
  };
}

export function startWaitForAuth({
  authTargetKey,
  skillName,
  deviceCode,
  missingKey,
  openId,
  scopes,
  requiredScopes = null,
  scopeInstallGrant = null,
  scopeInstallGrants = null,
  identity = "user",
  authReason = "app_scope",
  larkProfile = null,
  ctx,
  authMessageId = null,
  authWaiter = null,
  onAuthorized = null,
  onAuthCardSent = null,
  onCleanup = null,
  onPollAttached = null,
}) {
  if (!deviceCode && authReason === "user_grant") {
    fileLog(`waitForAuth: skipped for "${skillName}" authReason=user_grant without deviceCode`);
    return;
  }
  const waitCtx = buildAuthWaitContext(ctx);
  // 如果该技能已有轮询在跑，先清理旧的，避免重复
  const pollingKey = authTargetKey || skillName;
  const existing = activePollingIntervals.get(pollingKey);
  const timeline = [];
  const noteTimeline = (msg) => {
    timeline.push(`${new Date().toISOString()} ${msg}`);
  };
  if (existing) {
    if (existing.interval) clearInterval(existing.interval);
    existing.active = false;
    cancelAuthWaiter(existing.authWaiter);
    fileLog(`waitForAuth: replacing existing poll for "${pollingKey}"`);
    noteTimeline(`replacing existing poll pollingKey=${pollingKey}`);
  }

  fileLog(
    `waitForAuth: starting skill="${skillName}" build=${PLUGIN_RUNTIME_BUILD} authReason=${authReason} deviceCodePresent=${deviceCode ? "yes" : "no"}`,
  );
  noteTimeline(
    `waitForAuth start authReason=${authReason} deviceCodePresent=${deviceCode ? "yes" : "no"} authWaiter=${authWaiter?.started ? "yes" : "no"}`,
  );
  const t0 = Date.now();
  // 应用 scope 轮询走 Open API，间隔短一些以便「配置成功」后尽快切到 2/2
  const POLL_MS = authReason === "user_grant" ? 5000 : 5000;
  // 飞书 H5 秒成功时 token 写入 lark-cli 可能晚于 device 子进程 exit；grace 内继续只 poll verify
  const USER_GRANT_WAITER_GRACE_MS = 60000;
  // 最大等待 3 分钟，与发卡冷却时间一致
  const MAX_WAIT_MS = 180000;
  const deadlineMs = t0 + MAX_WAIT_MS;
  let interval = null;
  let watchdog = null;
  let completed = false;
  let pollInFlight = false;
  const entry = {
    interval: null,
    active: true,
    authWaiter,
    startedAtMs: t0,
    lastPollAtMs: t0,
    pollInFlight: false,
    registrationAuthorized: false,
    waiterExitedAtMs: null,
  };

  // 注册到全局 map，供后续去重。entry identity also prevents an old in-flight
  // poll from clearing or completing the poll that replaced it.
  activePollingIntervals.set(pollingKey, entry);
  const isActive = () => entry.active && !completed && activePollingIntervals.get(pollingKey) === entry;

  const forceTimeoutCleanup = async (source) => {
    if (completed) return;
    fileLog(
      `waitForAuth: "${skillName}" force timeout from ${source} after ${Math.round((Date.now() - t0) / 1000)}s authReason=${authReason}`,
    );
    noteTimeline(`force timeout source=${source} elapsedSec=${Math.round((Date.now() - t0) / 1000)}`);
    if (authMessageId) {
      await reportAuthStageFailure({
        messageId: authMessageId,
        skillName,
        accountId: waitCtx?.accountId || waitCtx?.account,
        state: "timeout",
        authReason,
        authTargetKey,
        waitCtx,
        openId,
        timeline,
        authWaiter,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      }).catch(() => null);
    }
    cleanup({ reason: "timeout" });
  };

  const cleanup = (options = {}) => {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    completed = true;
    entry.active = false;
    entry.pollInFlight = false;
    cancelAuthWaiter(authWaiter);
    if (activePollingIntervals.get(pollingKey) === entry) {
      activePollingIntervals.delete(pollingKey);
    }
    if (typeof onCleanup === "function") {
      try {
        onCleanup(options);
      } catch (e) {
        fileLog(`waitForAuth onCleanup error: ${e?.message || e}`);
      }
    }
  };

  const poll = async () => {
    if (!isActive() || pollInFlight) return;
    pollInFlight = true;
    entry.pollInFlight = true;
    entry.lastPollAtMs = Date.now();
    try {
      const elapsed = Date.now() - t0;
      if (elapsed > MAX_WAIT_MS) {
        fileLog(
          `waitForAuth: "${skillName}" timed out after ${Math.round(elapsed / 1000)}s`,
        );
        noteTimeline(`poll max wait exceeded elapsedSec=${Math.round(elapsed / 1000)}`);
        if (authMessageId) {
          fileLog(`waitForAuth: updating timed-out auth card skill="${skillName}" authReason=${authReason} msg=${authMessageId}`);
          await reportAuthStageFailure({
            messageId: authMessageId,
            skillName,
            accountId: waitCtx?.accountId || waitCtx?.account,
            state: "timeout",
            authReason,
            authTargetKey,
            waitCtx,
            openId,
            timeline,
            authWaiter,
            elapsedSec: Math.round(elapsed / 1000),
          });
        }
        cleanup({ reason: "timeout" });
        return;
      }

      fileLog(
        `waitForAuth: "${skillName}" poll tick build=${PLUGIN_RUNTIME_BUILD} authReason=${authReason} elapsed=${Math.round(elapsed / 1000)}s`,
      );
      const normalizedIdentity = normalizeAuthIdentity(identity);
      let registrationReady = entry.registrationAuthorized === true;
      if (authReason === "app_scope") {
        if (!deviceCode) {
          fileLog(
            `scopeGrantDevicePoll skill="${skillName}" skipped reason=no_device_code accountId=${waitCtx?.accountId || waitCtx?.account || "<none>"}`,
          );
        } else {
          const credentials = await getAccountCredentials(waitCtx).catch((error) => {
            fileLog(`scopeGrantDevicePoll skill="${skillName}" credentials_error=${error?.message || error}`);
            return null;
          });
          if (!credentials?.appId) {
            fileLog(
              `scopeGrantDevicePoll skill="${skillName}" skipped reason=no_app_id accountId=${waitCtx?.accountId || waitCtx?.account || "<none>"}`,
            );
          } else {
            const registration = await pollScopeGrantRegistration({
              brand: credentials.brand,
              deviceCode,
              appId: credentials.appId,
            }).catch((error) => ({
              status: "failed",
              error: error?.message || String(error),
            }));
            fileLog(
              `scopeGrantDevicePoll skill="${skillName}" status=${registration?.status || "unknown"} attempt=${registration?.attempt || "<none>"} error=${registration?.error || "<none>"}`,
            );
            if (registration?.status === "authorized") {
              entry.registrationAuthorized = true;
              registrationReady = true;
              invalidateAppScopesCache(credentials.appId);
            }
            if (registration?.status === "denied") {
              noteTimeline(
                `scopeGrantDevicePoll denied error=${registration?.error || "<none>"} attempt=${registration?.attempt || "<none>"}`,
              );
              if (authMessageId) {
                await reportAuthStageFailure({
                  messageId: authMessageId,
                  skillName,
                  accountId: waitCtx?.accountId || waitCtx?.account,
                  state: "denied",
                  authReason,
                  authTargetKey,
                  waitCtx,
                  openId,
                  timeline,
                  registration,
                  authWaiter,
                  elapsedSec: Math.round(elapsed / 1000),
                });
              }
              cleanup({ reason: "denied" });
              return;
            }
          }
        }
      }
      const scopeFetchOptions = authReason === "user_grant" ? {} : { forceRefresh: true };
      const appScopeEntries = await withAsyncTimeout(
        getAppScopeEntries(waitCtx, scopeFetchOptions),
        25000,
        `getAppScopeEntries(${skillName})`,
      ).catch((error) => {
        fileLog(`waitForAuth: "${skillName}" getAppScopeEntries failed: ${error?.message || error}`);
        return null;
      });
      const userRequiredScopes = filterScopesNeedingUserGrant(
        Array.isArray(requiredScopes) && requiredScopes.length ? requiredScopes : scopes,
        appScopeEntries,
        { scopeInstallGrant, scopeInstallGrants },
      );
      let check;
      if (authReason === "user_grant") {
        check = await withAsyncTimeout(
          checkUserGrant(openId, userRequiredScopes, waitCtx, {
            acceptEmptyMissing: true,
            larkProfile,
          }),
          35000,
          `checkUserGrant(${skillName})`,
        ).catch((error) => {
          fileLog(`waitForAuth: "${skillName}" checkUserGrant failed: ${error?.message || error}`);
          return { ok: false, missing: userRequiredScopes, granted: [], unavailable: true, reason: "poll timeout" };
        });
      } else {
        check = await checkScopes(scopes, waitCtx, {
          identity: normalizedIdentity,
          appScopeEntries,
          scopeInstallGrant,
          scopeInstallGrants,
        });
        if (!check?.ok) {
          const sampleScopes = Array.isArray(appScopeEntries)
            ? appScopeEntries.slice(0, 8).map((item) => `${item.scope}:${item.identity || "?"}`).join(", ")
            : "<none>";
          fileLog(
            `waitForAuth: "${skillName}" app scope poll still missing=${JSON.stringify(check?.missing || [])} apiScopeSample=${sampleScopes} elapsed=${Math.round(elapsed / 1000)}s registrationReady=${registrationReady}`,
          );
        }
      }
      if (!isActive()) return;
      if (authReason === "user_grant") {
        const checkLog = formatGrantCheckForLog(check, { acceptEmptyMissing: true });
        fileLog(`waitForAuth: "${skillName}" user grant poll result ${checkLog}`);
        noteTimeline(`checkUserGrant ${checkLog}`);
      }
      if (authReason === "user_grant" && isUserGrantWaiterDenial(authWaiter)) {
        fileLog(
          `waitForAuth: "${skillName}" user grant denied exitCode=${authWaiter?.exitCode ?? "unknown"} output=${String(authWaiter?.output || "").slice(0, 240)}`,
        );
        noteTimeline("user grant denied");
        if (authMessageId) {
          await reportAuthStageFailure({
            messageId: authMessageId,
            skillName,
            accountId: waitCtx?.accountId || waitCtx?.account,
            state: "denied",
            authReason,
            authTargetKey,
            waitCtx,
            openId,
            timeline,
            check,
            authWaiter,
            elapsedSec: Math.round(elapsed / 1000),
          });
        }
        cleanup({ reason: "denied" });
        return;
      }
      if (authReason === "user_grant" && authWaiter?.exited && !check?.ok) {
        if (!entry.waiterExitedAtMs) {
          entry.waiterExitedAtMs = Date.now();
          noteTimeline(
            `device waiter exited exitCode=${authWaiter.exitCode ?? "unknown"} signal=${authWaiter.signal ?? "<none>"}`,
          );
        }
        const graceElapsedMs = Date.now() - entry.waiterExitedAtMs;
        if (graceElapsedMs < USER_GRANT_WAITER_GRACE_MS) {
          fileLog(
            `waitForAuth: "${skillName}" user grant waiter exited code=${authWaiter.exitCode ?? "unknown"} verify still pending; grace ${Math.round(graceElapsedMs / 1000)}s/${Math.round(USER_GRANT_WAITER_GRACE_MS / 1000)}s oauthState=${check?.oauthState || "<none>"}`,
          );
          noteTimeline(
            `grace pending ${Math.round(graceElapsedMs / 1000)}s oauthState=${check?.oauthState || "<none>"}`,
          );
          return;
        }
        fileLog(
          `waitForAuth: "${skillName}" user grant waiter exited without authorization after grace code=${authWaiter.exitCode ?? "unknown"} reason=${check?.reason || "<none>"}`,
        );
        noteTimeline("grace exhausted; reporting auth failure to card");
        if (authMessageId) {
          await reportAuthStageFailure({
            messageId: authMessageId,
            skillName,
            accountId: waitCtx?.accountId || waitCtx?.account,
            state: check?.oauthState === "oauth_runtime_unavailable" ? "oauth_runtime_unavailable" : "cancelled",
            authReason,
            authTargetKey,
            waitCtx,
            openId,
            timeline,
            check,
            authWaiter,
            graceElapsedSec: Math.round(graceElapsedMs / 1000),
            elapsedSec: Math.round(elapsed / 1000),
          });
        }
        cleanup({ reason: "cancelled" });
        return;
      }
      if (check?.ok) {
        let userGrantComplete = false;
        if (normalizedIdentity === "user" && authReason !== "user_grant") {
          invalidateAppScopesCache(waitCtx?.appId || waitCtx?.feishuAppId);
          const userGrantCheck = await withAsyncTimeout(
            checkUserGrant(openId, userRequiredScopes, waitCtx, {
              requireScopeDetails: true,
              larkProfile,
            }),
            35000,
            `checkUserGrantPrecheck(${skillName})`,
          ).catch((error) => {
            fileLog(`waitForAuth: "${skillName}" user grant precheck failed: ${error?.message || error}`);
            return { ok: false, missing: userRequiredScopes, granted: [], unavailable: true, reason: "poll timeout" };
          });
          if (!isActive()) return;
          fileLog(`waitForAuth: "${skillName}" user grant precheck result ${formatGrantCheckForLog(userGrantCheck, { requireScopeDetails: true })}`);
          if (!userGrantCheck.ok) {
            const userGrantMissing = userGrantCheck.missing?.length ? userGrantCheck.missing : userRequiredScopes;
            const oauthState = userGrantCheck.oauthState || null;
            fileLog(
              `waitForAuth: "${skillName}" app scope authorized, user grant missing or unverifiable: ${userGrantMissing.join(", ")} reason=${userGrantCheck.reason || "not granted"}`,
            );
            const login = await startLogin(userGrantMissing, waitCtx, {
              identity: "user",
              authReason: "user_grant",
              requiredScopes: userRequiredScopes,
              appScopeEntries,
              scopeInstallGrant,
              scopeInstallGrants,
              larkProfile,
              ...(oauthState ? { oauthState } : {}),
            });
            if (!isActive()) return;
            if (login?.verificationUrl) {
              const sent = await deliverAuthCard({
                skillName,
                missing: login.requestedScopes?.length ? login.requestedScopes : userGrantMissing,
                requestedScopes: login.requestedScopes,
                verificationUrl: login.verificationUrl,
                userCode: login.userCode,
                deviceCode: login.deviceCode,
                openId,
                accountId: waitCtx?.accountId || waitCtx?.account,
                identity: "user",
                authReason: "user_grant",
                authStep: 2,
                handoffFromAppScope: true,
                existingMessageId: authMessageId,
                ...(oauthState ? { oauthState } : {}),
              });
              if (!isActive()) return;
              if (sent?.messageId) {
                fileLog(
                  `waitForAuth: "${skillName}" app scope authorized; user grant step on msg=${sent.messageId} updated=${sent.updated === true}`,
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
                      deviceCode: login.deviceCode,
                      larkProfile: login.larkProfile || larkProfile,
                      ctx: waitCtx,
                    });
                    if (!isActive()) return;
                  } catch (callbackError) {
                    fileLog(`waitForAuth: onAuthCardSent callback failed for "${skillName}": ${callbackError?.message || callbackError}`);
                  }
                }
                const handoffCallbacks = {
                  onAuthorized,
                  onAuthCardSent,
                  onCleanup,
                  onPollAttached,
                };
                cleanup({ reason: "handoff" });
                startWaitForAuth({
                  authTargetKey,
                  skillName,
                  deviceCode: login.deviceCode,
                  missingKey: userRequiredScopes.slice().sort().join("|"),
                  openId,
                  scopes: userGrantMissing,
                  requiredScopes: userRequiredScopes,
                  scopeInstallGrant,
                  scopeInstallGrants,
                  identity: "user",
                  authReason: "user_grant",
                  larkProfile: login.larkProfile || larkProfile,
                  ctx: waitCtx,
                  authMessageId: sent.messageId,
                  authWaiter: login.authWaiter,
                  ...handoffCallbacks,
                });
                return;
              }
              fileLog(
                `waitForAuth: "${skillName}" user grant card failed after app scope authorization: ${sent?.error || "send failed"}`,
              );
              return;
            }
            fileLog(
              `waitForAuth: "${skillName}" start user grant after app scope authorization failed: ${login?.error || "unknown error"} accountId=${waitCtx?.accountId || "<none>"}`,
            );
            return;
          }
          userGrantComplete = true;
          fileLog(
            `waitForAuth: "${skillName}" app scope authorized and user grant verified with scope details`,
          );
        }
        const needsUserGrantStep =
          normalizedIdentity === "user" &&
          authReason === "app_scope" &&
          userRequiredScopes.length > 0;
        if (needsUserGrantStep && !userGrantComplete) {
          fileLog(
            `waitForAuth: "${skillName}" user OAuth still required; skip app-only done card and keep polling for handoff`,
          );
          return;
        }
        if (authMessageId) {
          await updateAuthStageCard({
            messageId: authMessageId,
            skillName,
            authReason,
            accountId: waitCtx?.accountId || waitCtx?.account,
            userGrantComplete,
            needsUserGrantStep: false,
          });
          if (!isActive()) return;
        }
        cleanup({ reason: "authorized" });
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
              ctx: waitCtx,
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
    } finally {
      pollInFlight = false;
      entry.pollInFlight = false;
    }
  };

  interval = setInterval(poll, POLL_MS);
  entry.interval = interval;
  watchdog = setInterval(() => {
    if (completed || !entry.active) return;
    if (Date.now() >= deadlineMs) {
      void forceTimeoutCleanup("watchdog");
    }
  }, 10000);
  if (typeof onPollAttached === "function") {
    try {
      onPollAttached({ authTargetKey, skillName, authReason, pollingKey });
    } catch (error) {
      fileLog(`waitForAuth: onPollAttached failed for "${skillName}": ${error?.message || error}`);
    }
  }
  poll();
}

function displayedGrantScopes({ missing, requestedScopes }) {
  const submitted = uniqueScopes(requestedScopes);
  if (submitted.length) return submitted;
  return uniqueScopes(missing);
}

function buildAuthCardPayload({
  skillName,
  missing,
  requestedScopes = null,
  verificationUrl,
  identity = "user",
  authReason = "app_scope",
  oauthState = null,
  scopeGrantDual = false,
  authStep = null,
  handoffFromAppScope = false,
  userGrantAlreadyComplete = false,
}) {
  const authUrl = sidebarApplink(verificationUrl);
  const scopes = displayedGrantScopes({ missing, requestedScopes });
  const scopeCount = scopes.length;
  const scopeLines = scopes.map((s) => `• \`${s}\``).join("\n");
  const normalizedIdentity = normalizeAuthIdentity(identity);
  const isUserGrant = authReason === "user_grant";
  const isDualScopeGrant = scopeGrantDual === true && !isUserGrant && !userGrantAlreadyComplete;
  const isReauthorization = oauthState === "oauth_reauth_required";
  const isScopeMissing = oauthState === "scope_missing";
  const stepPrefix = authStep === 1 ? "（1/2）" : authStep === 2 ? "（2/2）" : "";
  const authTitle = handoffFromAppScope
    ? `飞书授权${stepPrefix} 请完成用户登录`
    : isUserGrant
      ? (authStep === 2 ? `飞书授权${stepPrefix} 请完成用户登录` : "飞书用户授权")
      : isDualScopeGrant
        ? `飞书授权${stepPrefix || "（1/2）"} 应用与用户权限`
        : "飞书应用权限开通提醒";
  const authSubtitle = handoffFromAppScope || (isUserGrant && authStep === 2)
    ? `技能 “${skillName}” 应用权限已就绪，还差您的登录授权`
    : isUserGrant
      ? `技能 “${skillName}” 需要您授权用户身份`
      : isDualScopeGrant
        ? `技能 “${skillName}” 同页确认应用与用户身份权限`
        : `技能 “${skillName}” 需要开通${normalizedIdentity === "user" ? "用户身份" : "应用身份"}权限`;
  const authIntro = handoffFromAppScope || (isUserGrant && authStep === 2)
    ? `应用侧权限已在后台就绪。请点击下方按钮 **完成用户 OAuth 登录**（约 1 步），以便以您的身份访问 **${scopeCount}** 项权限。`
    : isReauthorization
    ? `技能需要你重新授权用户身份，以恢复 **${scopeCount}** 项飞书权限访问。`
    : isScopeMissing
    ? `当前授权缺少所需权限，技能需要补齐 **${scopeCount}** 项飞书权限访问。`
    : isUserGrant
    ? `请完成用户登录授权，以访问 **${scopeCount}** 项飞书权限。`
    : isDualScopeGrant
      ? `请在本页一次性确认 **${scopeCount}** 项权限（应用开通与用户身份授权在同一页完成）；确认后 **本卡片会自动变为第 2 步登录**，无需再找新消息。`
      : `技能需要应用先开通 **${scopeCount}** 项飞书${normalizedIdentity === "user" ? "用户身份" : "应用身份"}权限。`;
  const scopePanelTitle = isUserGrant || handoffFromAppScope ? "查看待授权权限" : "查看待开通权限";
  const buttonText = isUserGrant || handoffFromAppScope ? "🚀 继续 · 用户登录授权" : "🚀 前往开通权限";
  const footerHint = handoffFromAppScope || (isUserGrant && authStep === 2)
    ? "<font color='grey'>📝 最后一步：完成登录后可直接重试技能</font>"
    : isUserGrant
    ? "<font color='grey'>📝 点按钮完成用户登录授权</font>"
    : isDualScopeGrant
      ? "<font color='grey'>📝 第 1 步：同页确认权限；完成后卡片自动进入第 2 步</font>"
      : "<font color='grey'>📝 点「前往开通权限」完成应用权限开通</font>";
  const runtimeBuildHint = `<font color='grey'>runtime ${PLUGIN_RUNTIME_BUILD}</font>`;
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
                  content: `${footerHint}\n${runtimeBuildHint}`,
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
  return { card, authUrl };
}

async function deliverAuthCard({
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
  scopeGrantDual = false,
  requestedScopes = null,
  authStep = null,
  handoffFromAppScope = false,
  userGrantAlreadyComplete = false,
  existingMessageId = null,
}) {
  const target = receiveId
    ? { receiveId, receiveIdType: receiveIdType || "open_id" }
    : openId
      ? { receiveId: openId, receiveIdType: "open_id" }
      : null;
  const { card, authUrl } = buildAuthCardPayload({
    skillName,
    missing,
    requestedScopes,
    verificationUrl,
    identity,
    authReason,
    oauthState,
    scopeGrantDual,
    authStep,
    handoffFromAppScope,
    userGrantAlreadyComplete,
  });
  fileLog(
    `deliverAuthCard: skill="${skillName}" authStep=${authStep || "none"} handoff=${handoffFromAppScope} userGrantAlreadyComplete=${userGrantAlreadyComplete} updateMsg=${existingMessageId || "<new>"} authUrl=${authUrl || "<EMPTY!>"} userCode=${userCode || "<none>"}`,
  );
  if (existingMessageId) {
    const updated = await updateInteractiveCard(existingMessageId, card, { accountId });
    if (updated.messageId) {
      return { messageId: existingMessageId, updated: true };
    }
    fileLog(`deliverAuthCard: card update failed, fallback to send: ${updated.error || "unknown"}`);
  }
  if (!target?.receiveId) return { error: "no receiveId" };
  return sendInteractiveCard(target.receiveId, target.receiveIdType, card, 20000, { accountId });
}

export async function sendAuthCard(params) {
  const dualStepPending =
    params.scopeGrantDual &&
    params.authReason !== "user_grant" &&
    params.userGrantAlreadyComplete !== true;
  const authStep = dualStepPending ? (params.authStep ?? 1) : (params.authStep ?? null);
  return deliverAuthCard({ ...params, authStep, existingMessageId: null });
}

// ---- auto-sync lark-cli profiles from openclaw.json feishu accounts ----
export function syncLarkCliProfiles(apiConfig) {
  const larkCliDir = join(homedir(), ".lark-cli", "openclaw");
  const larkCliConfig = join(larkCliDir, "config.json");
  const feishuCfg = apiConfig?.channels?.feishu;
  if (!feishuCfg) return;
  const desired = new Map();
  if (feishuCfg.appId && feishuCfg.appSecret) {
    desired.set(String(feishuCfg.appId), String(feishuCfg.appSecret));
  }
  const accounts = feishuCfg.accounts || {};
  for (const acc of Object.values(accounts)) {
    const merged = { ...feishuCfg, ...acc };
    if (merged.appId && merged.appSecret) {
      desired.set(String(merged.appId), String(merged.appSecret));
    }
  }
  if (desired.size === 0) return;
  let config;
  try {
    config = JSON.parse(readFileSync(larkCliConfig, "utf-8"));
  } catch {
    config = { apps: [] };
  }
  if (!Array.isArray(config.apps)) config.apps = [];
  const existing = new Set(config.apps.map((a) => a.appId));
  let added = 0;
  for (const [appId, appSecret] of desired) {
    if (existing.has(appId)) continue;
    config.apps.push({
      appId,
      appSecret,
      brand: "feishu",
      defaultAs: "user",
      strictMode: "off",
      users: null,
    });
    added++;
    fileLog(`syncLarkCliProfiles: added profile appId=${appId}`);
  }
  if (added > 0) {
    try {
      mkdirSync(larkCliDir, { recursive: true });
      writeFileSync(larkCliConfig, `${JSON.stringify(config, null, 2)}\n`);
      fileLog(`syncLarkCliProfiles: wrote ${added} new profile(s)`);
    } catch (e) {
      fileLog(`syncLarkCliProfiles: write failed: ${e?.message || e}`);
    }
  } else {
    fileLog("syncLarkCliProfiles: all profiles already present");
  }
}
