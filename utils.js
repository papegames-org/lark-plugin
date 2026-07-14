// utils.js — Lark Scope Pre-Auth 工具函数集
// 包含：日志、workspace 查找、skill-map 构建、auth 操作等（frontmatter 解析已移至 parse-meta.js）
// ============================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { beginScopeGrantFlow, callFeishuOpenApi, resolveFeishuBrand } from "./feishu-runtime.js";

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
  console.log(`[lark-scope-preauth] ${new Date().toISOString()} ${msg}`);
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

export function cacheSenderId(ctx, senderId) {
  if (!senderId) return;
  if (ctx?.sessionId) cachedSenderBySession.set(ctx.sessionId, senderId);
  if (ctx?.sessionKey) cachedSenderBySession.set(ctx.sessionKey, senderId);
}

export function getCachedSenderId(ctx) {
  if (ctx?.senderId || ctx?.senderOpenId || ctx?.openId) {
    return ctx.senderId || ctx.senderOpenId || ctx.openId;
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

export function getAccountId(ctx) {
  const direct = ctx?.accountId || ctx?.account || ctx?.channelAccountId || null;
  if (direct) return direct;
  if (ctx?.sessionId && cachedAccountBySession.has(ctx.sessionId)) {
    return cachedAccountBySession.get(ctx.sessionId);
  }
  if (ctx?.sessionKey && cachedAccountBySession.has(ctx.sessionKey)) {
    return cachedAccountBySession.get(ctx.sessionKey);
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

  const promise = callFeishuOpenApi(credentials, {
    method: "GET",
    path: `/open-apis/application/v6/applications/${aid}`,
    params: { lang: "zh_cn" },
  }).then((response) => {
    if (!response || response.code !== 0) {
      fileLog(`getAppScopes: API failed: ${response?.msg || response?.message || "unparseable"}`);
      appScopesCache.delete(aid);
      return null;
    }
    const scopesArr = response?.data?.app?.scopes;
    if (!Array.isArray(scopesArr)) {
      appScopesCache.delete(aid);
      return null;
    }
    const scopes = [...new Set(scopesArr.map((item) => item?.scope).filter(Boolean))];
    appScopesCache.set(aid, {
      scopes,
      expiresAt: Date.now() + APP_SCOPES_CACHE_TTL_MS,
      promise: null,
    });
    return scopes;
  }).catch((error) => {
    fileLog(`getAppScopes: request failed: ${error?.message || error}`);
    appScopesCache.delete(aid);
    return null;
  });

  appScopesCache.set(aid, { scopes: null, expiresAt: 0, promise });
  return promise;
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

export async function startLogin(missing, ctx) {
  if (!missing?.length) return { error: "no scopes" };
  try {
    const credentials = await getAccountCredentials(ctx);
    return await beginScopeGrantFlow({
      appId: credentials.appId,
      brand: credentials.brand,
      scopes: missing,
    });
  } catch (error) {
    return { error: String(error?.message || error) };
  }
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

async function sendInteractiveCard(openId, card, timeoutMs = 20000, ctx = {}) {
  if (!openId) return { error: "no openId" };
  if (pluginApiRef?.tools?.feishu_im_user_message) {
    try {
      const response = await pluginApiRef.tools.feishu_im_user_message({
        action: "send",
        receive_id: openId,
        receive_id_type: "open_id",
        msg_type: "interactive",
        content: JSON.stringify(card),
      });
      return {
        messageId: response?.data?.message_id || response?.message_id || response?.id || (response?.success ? "sent" : null),
      };
    } catch (error) {
      fileLog(`sendInteractiveCard: plugin tool failed: ${error?.message || error}`);
    }
  }
  const credentials = await getAccountCredentials(ctx);
  try {
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
    return { messageId: response?.data?.message_id || null };
  } catch (error) {
    return { error: String(error?.message || error) };
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
      icon: { tag: "standard_icon", token: "check_outlined" },
    },
    body: {
      elements: [
        { tag: "markdown", content: `技能 **${skillName}** 的飞书权限已授权成功！现在可以正常使用啦 🦐` },
      ],
    },
  };
  return sendInteractiveCard(openId, doneCard, 10000, { accountId });
}

export function startWaitForAuth({ authTargetKey, skillName, deviceCode, missingKey, openId, scopes, ctx }) {
  if (!deviceCode) return;
  // 如果该技能已有轮询在跑，先清理旧的，避免重复
  const pollingKey = authTargetKey || skillName;
  const existing = activePollingIntervals.get(pollingKey);
  if (existing) {
    clearInterval(existing.interval);
    existing.completed = true;
    fileLog(`waitForAuth: replacing existing poll for "${pollingKey}"`);
  }

  fileLog(`waitForAuth: starting for "${skillName}" deviceCode=${deviceCode.slice(0, 12)}...`);
  const t0 = Date.now();
  // 轮询间隔 15 秒（用户手动授权通常需要更长时间，无需高频请求）
  const POLL_MS = 15000;
  // 最大等待 3 分钟，与发卡冷却时间一致
  const MAX_WAIT_MS = 180000;
  let interval = null;
  let completed = false;

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

      const appScopes = await getAppScopes(ctx);
      if (appScopes) {
        const appScopesSet = new Set(appScopes);
        const allGranted = scopes.every((s) => appScopesSet.has(s));
        if (allGranted) {
          cleanup();
          fileLog(`waitForAuth: "${skillName}" authorized! (${Math.round(elapsed / 1000)}s)`);
          if (openId) {
            const sent = await sendAuthSuccessCard({ skillName, openId, accountId: ctx?.accountId || ctx?.account });
            if (!sent?.messageId && sent?.error) {
              fileLog(`waitForAuth: auth success card failed for "${skillName}": ${sent.error}`);
            }
          }
          return;
        }
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

export async function sendAuthCard({ skillName, missing, verificationUrl, userCode, openId, accountId }) {
  if (!openId) return { error: "no openId" };
  // 用 sidebar-semi applink 包裹，在飞书内以侧边栏打开，不跳转系统浏览器
  const authUrl = sidebarApplink(verificationUrl);
  fileLog(`sendAuthCard: skill="${skillName}" authUrl=${authUrl || "<EMPTY!>"} userCode=${userCode || "<none>"} openId=${openId}`);
  const scopeCount = missing.length;
  const scopeLines = missing.map((s) => `• \`${s}\``).join("\n");
  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "飞书权限授权提醒" },
      subtitle: { tag: "plain_text", content: `技能 “${skillName}” 需要你确认` },
      icon: { tag: "standard_icon", token: "safe_outlined" },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `技能需要 **${scopeCount}** 项飞书权限，目前还没授权。点开下方抽屉可查看具体权限。`,
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          background_color: "grey-50",
          header: {
            title: { tag: "markdown", content: `**🔍 查看待授权权限（${scopeCount} 项）**` },
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
          text: { tag: "plain_text", content: "🚀 前往授权" },
          type: "primary",
          width: "fill",
          size: "medium",
          behaviors: [{ type: "open_url", default_url: authUrl }],
        },
        {
          tag: "markdown",
          content: `<font color='grey'>📝 点「前往授权」完成授权</font>`,
        }
      ],
    },
  };
  return sendInteractiveCard(openId, card, 20000, { accountId });
}
