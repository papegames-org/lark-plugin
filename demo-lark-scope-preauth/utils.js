// utils.js — Lark Scope Pre-Auth 工具函数集
// 包含：日志、workspace 查找、skill-map 构建、auth 操作等（frontmatter 解析已移至 parse-meta.js）
// ============================================================

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---------- 模块级状态（与 index.js register 共享）----------

/** workspace 缓存（按 sessionId） */
export const cachedWorkspaceBySession = new Map();
/** account 缓存（按 sessionId/sessionKey） */
export const cachedAccountBySession = new Map();
/** register 时拿到的 api.config 引用（权威来源，免读文件）
 *  导出为 let 绑定，index.js 通过 setApiConfigRef() 写入 */
export let apiConfigRef = null;

/** 设置 api.config 引用（仅内部使用，由 register 在 index.js 调用） */
export function setApiConfigRef(val) {
  apiConfigRef = val;
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

export function getDefaultSkillRoots(ctx) {
  const ws = resolveWorkspaceDir(ctx);
  return [
    join(homedir(), ".agents", "skills"),
    join(ws, "skills"),
  ];
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

// ---------- auth：lark-cli 幂等检查 + no-wait 授权 ----------

const LARK_CLI = "lark-cli";

export function run(args, timeoutMs = 20000) {
  return new Promise((res) => {
    execFile(LARK_CLI, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      res({ code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "",
            error: err && typeof err.code !== "number" ? err : null });
    });
  });
}

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

export async function getAppId(ctx) {
  const cfg = apiConfigRef;
  const cfgSource = "api.config";
  if (!cfg) {
    throw new Error(`appId unresolved: api.config unavailable (apiConfigRef null)`);
  }
  const accounts = cfg?.channels?.feishu?.accounts || null;
  if (!accounts || typeof accounts !== "object") {
    throw new Error(`appId unresolved: channels.feishu.accounts missing in api.config`);
  }
  const accountId = getAccountId(ctx);
  if (accountId && accounts[accountId]?.appId) {
    const appId = accounts[accountId].appId;
    // fileLog(`getAppId: from ${cfgSource} accounts[${accountId}].appId=${appId}`);
    return appId;
  }
  const keys = Object.keys(accounts);
  if (!accountId && keys.length === 1 && accounts[keys[0]]?.appId) {
    const appId = accounts[keys[0]].appId;
    // fileLog(`getAppId: single-account fallback (${cfgSource}) accounts[${keys[0]}].appId=${appId}`);
    return appId;
  }
  throw new Error(`appId unresolved: accountId=${accountId || "<empty>"} not found among [${keys.join(", ")}]`);
}

export async function getAppScopes(ctx) {
  const aid = await getAppId(ctx);
  fileLog(`getAppScopes: resolved appId=${aid || "<empty>"}`);
  if (!aid) return null;
  const { stdout } = await run(["api", "GET",
    `/open-apis/application/v6/applications/${aid}`,
    "--as", "bot", "--params", '{"lang":"zh_cn"}'
  ], 15000);
  const j = parseJsonLoose(stdout);
  if (!j || j.code !== 0) {
    fileLog(`getAppScopes: API failed: ${j?.msg || j?.error?.message || "unparseable"}`);
    return null;
  }
  const scopesArr = j?.data?.app?.scopes;
  if (!Array.isArray(scopesArr)) return null;
  return scopesArr.map((s) => s.scope);
}

export async function checkScopes(scopes, ctx) {
  if (!scopes?.length) return { ok: true, missing: [], granted: [] };
  const appScopes = await getAppScopes(ctx);
  if (!appScopes) {
    fileLog(`checkScopes: getAppScopes failed, falling back to all missing`);
    return { ok: false, missing: scopes, granted: [] };
  }
  const missing = scopes.filter((s) => !appScopes.includes(s));
  const granted = scopes.filter((s) => appScopes.includes(s));
  fileLog(`checkScopes: appScopes=${appScopes.length}, missing=${JSON.stringify(missing)}, granted=${JSON.stringify(granted)}`);
  return { ok: missing.length === 0, missing, granted };
}

export async function startLogin(missing) {
  if (!missing?.length) return { error: "no scopes" };
  const { stdout, stderr, error } = await run(
    ["auth", "login", "--no-wait", "--json", "--scope", missing.join(" ")], 30000);
  if (error) return { error: String(error.message || error) };
  const j = parseJsonLoose(stdout);
  if (!j) return { error: `unparseable: ${(stdout || stderr).slice(0, 200)}` };
  const vUrl = j.verification_uri_complete || j.verificationUriComplete ||
      j.verification_uri || j.verificationUri || j.verification_url || j.url;
  let uCode = j.user_code || j.userCode;
  if (!uCode && vUrl) {
    const m = String(vUrl).match(/[?&]user_code=([^&]+)/);
    if (m) uCode = decodeURIComponent(m[1]);
  }
  return {
    verificationUrl: vUrl,
    userCode: uCode,
    deviceCode: j.device_code || j.deviceCode,
    expiresIn: j.expires_in || j.expiresIn,
  };
}

export async function getAuthedUser() {
  const { stdout } = await run(["auth", "list"], 10000);
  const j = parseJsonLoose(stdout);
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.profiles) ? j.profiles : null);
  if (!arr || !arr.length) return null;
  const p = arr[0];
  return { openId: p.userOpenId || p.user_open_id || p.openId };
}

export function sidebarApplink(authUrl) {
  const q = encodeURIComponent(authUrl);
  return `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${q}`;
}

/** 按 skillName 去重的轮询定时器，防止同一技能创建多个轮询 */
const activePollingIntervals = new Map();

export function startWaitForAuth({ skillName, deviceCode, missingKey, openId, scopes, ctx }) {
  if (!deviceCode) return;
  // 如果该技能已有轮询在跑，先清理旧的，避免重复
  const existing = activePollingIntervals.get(skillName);
  if (existing) {
    clearInterval(existing.interval);
    existing.completed = true;
    fileLog(`waitForAuth: replacing existing poll for "${skillName}"`);
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
  activePollingIntervals.set(skillName, { interval: null, completed: false, get completedRef() { return completed; } });

  const cleanup = () => {
    if (interval) { clearInterval(interval); interval = null; }
    completed = true;
    activePollingIntervals.delete(skillName);
  };

  const poll = async () => {
    if (completed) return;
    const elapsed = Date.now() - t0;
    if (elapsed > MAX_WAIT_MS) {
      fileLog(`waitForAuth: "${skillName}" timed out after ${Math.round(elapsed / 1000)}s`);
      cleanup();
      return;
    }

    const appScopes = await getAppScopes(ctx);
    if (appScopes) {
      const allGranted = scopes.every((s) => appScopes.includes(s));
      if (allGranted) {
        completed = true;
        cleanup();
        fileLog(`waitForAuth: "${skillName}" authorized! (${Math.round(elapsed / 1000)}s)`);
        if (openId) {
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
          execFile("lark-cli", ["im", "+messages-send", "--as", "bot", "--msg-type", "interactive",
            "--user-id", openId, "--content", JSON.stringify(doneCard)], { timeout: 10000 }, () => {});
        }
        return;
      }
    }
  };

  interval = setInterval(poll, POLL_MS);
  // 更新全局 map 中的 interval 引用（创建时 interval 为 null，需要回填）
  const entry = activePollingIntervals.get(skillName);
  if (entry) entry.interval = interval;
  poll();
}

export async function sendAuthCard({ skillName, missing, verificationUrl, userCode, openId, appId }) {
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
  const args = ["im", "+messages-send", "--as", "bot", "--msg-type", "interactive",
    "--user-id", openId, "--content", JSON.stringify(card)];
  const { stdout, stderr, error } = await run(args, 20000);
  if (error) return { error: String(error.message || error) };
  const j = parseJsonLoose(stdout);
  if (j?.ok === false) return { error: j?.error?.message || "send failed" };
  return { messageId: j?.data?.message_id };
}