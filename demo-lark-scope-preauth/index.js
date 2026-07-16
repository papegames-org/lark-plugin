import { readLarkAuth } from "./parse-meta.js";
import {
  apiConfigRef,
  buildSkillMap,
  cachedAccountBySession,
  cachedWorkspaceBySession,
  checkScopes,
  fileLog,
  getAuthedUser,
  getDefaultSkillRoots,
  logCtxSnapshotOnce,
  resolvePath,
  resolveWorkspaceDir,
  sendAuthCard,
  setApiConfigRef,
  startLogin,
  startWaitForAuth
} from "./utils.js";

// ---------- 主入口（直接导出 plain entry object，无需 definePluginEntry）----------
export default {
  id: "lark-scope-preauth",
  name: "Lark Scope Pre-Auth",
  description:
    "Ensure user Lark scopes declared in a skill's SKILL.md are granted before the skill is used.",
  register(api) {
    // api.config = 完整 OpenClawConfig（含 channels.feishu.accounts），存起来给 getAppId 用（免读文件）
    // 防空覆盖：register 可能被调用多次，某些时机 api.config 尚未加载 feishu accounts（为空）。
    // 若直接覆盖，会用空值抹掉之前拿到的正确 accounts，导致 getAppId 失败、不发授权卡片。
    // 因此仅在「新 config 带非空 feishu.accounts」时才覆盖；否则保留上一次的非空值。
    const incoming = api.config || null;
    const incomingAccounts = incoming?.channels?.feishu?.accounts;
    const incomingHasAccounts = incomingAccounts && Object.keys(incomingAccounts).length > 0;
    if (incomingHasAccounts) {
      setApiConfigRef(incoming);
    } else if (!apiConfigRef) {
      setApiConfigRef(incoming);
    }
    // 插件私有配置在 api.pluginConfig（不是 api.config）
    const cfg = api.pluginConfig || {};
    fileLog(`rule=A apiConfig=${apiConfigRef ? "present" : "null"} feishuAccounts=${apiConfigRef?.channels?.feishu?.accounts ? Object.keys(apiConfigRef.channels.feishu.accounts).join(",") : "<none>"} incomingHadAccounts=${incomingHasAccounts}`);
    if (cfg.enabled === false) { fileLog("disabled by config"); return; }
    const blockRead = cfg.blockRead !== false;
    // 首次 register 时还不知道 cwd，在 before_tool_call 第一次调用时获取
    let resolvedRoots = null;
    function ensureRoots(ctx) {
      if (resolvedRoots) return;
      resolvedRoots = Array.isArray(cfg.skillRoots) && cfg.skillRoots.length
        ? cfg.skillRoots : getDefaultSkillRoots(ctx);
      const skillMapLocal = buildSkillMap(resolvedRoots);
      for (const [k, v] of skillMapLocal) skillMap.set(k, v);
      const banner = `indexed ${skillMap.size} SKILL.md across ${resolvedRoots.length} roots (blockRead=${blockRead})`;
      api.log?.info?.(`[lark-scope-preauth] ${banner}`);
      fileLog(banner);
    }

    const skillMap = new Map();
    const pendingAuthNotices = [];
    const skillAuthCache = new Map();

    api.on("before_prompt_build", async (event, ctx) => {
      if (ctx?.workspaceDir && ctx?.sessionId) {
        cachedWorkspaceBySession.set(ctx.sessionId, ctx.workspaceDir);
      }
      fileLog(`before_prompt_build ctx keys=${ctx ? JSON.stringify(Object.keys(ctx)) : "null"} accountId=${ctx?.accountId || "<none>"} account=${ctx?.account || "<none>"} channel=${ctx?.channel || "<none>"} messageProvider=${ctx?.messageProvider || "<none>"} channelId=${ctx?.channelId || "<none>"}`);
      const acc = ctx?.accountId || ctx?.account || null;
      if (acc && ctx?.sessionId) {
        cachedAccountBySession.set(ctx.sessionId, acc);
        fileLog(`accountId: cached from before_prompt_build sessionId=${ctx.sessionId} -> ${acc}`);
      }
    });

    api.on("message_received", async (event, ctx) => {
      const acc = event?.accountId || ctx?.accountId || ctx?.account || null;
      const sid = ctx?.sessionId || event?.sessionId || null;
      const skey = ctx?.sessionKey || event?.sessionKey || null;
      fileLog(`message_received accountId=${acc || "<none>"} sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"} eventKeys=${event ? JSON.stringify(Object.keys(event)) : "null"}`);
      if (acc) {
        if (sid) cachedAccountBySession.set(sid, acc);
        if (skey) cachedAccountBySession.set(skey, acc);
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      try {
        logCtxSnapshotOnce(ctx);
        fileLog(`hook: tool=${event?.toolName || ""} channel=${ctx?.channel || ""} path=${event?.params?.path || ""}`);
        ensureRoots(ctx);
        if (event.toolName !== "read") return;
        fileLog(`hook: read-enter rawPath=${event?.params?.path || ""} cwd=${ctx?.cwd || ""}`);
        if (ctx && ctx.channel && ctx.channel !== "feishu") return;
        const rawPath = event.params?.path;
        if (!rawPath) return;
        const wsDir = resolveWorkspaceDir(ctx);
        if (!wsDir) return;
        const abs = resolvePath(rawPath, ctx?.cwd, wsDir);
        const skillName = skillMap.get(abs);
        if (!skillName) {
          fileLog(`debug: no match for abs="${abs}" rawPath="${rawPath}" in skillMap (size=${skillMap.size}, keys.examples=${[...skillMap.keys()].slice(0, 3).join(", ")})`);
          return;
        }
        const larkAuth = readLarkAuth(abs);
        if (!larkAuth || larkAuth.identity !== "user" || !larkAuth.scopes.length) return;

        const check = await checkScopes(larkAuth.scopes, ctx);
        if (check.ok) { pendingAuthNotices.length = 0; skillAuthCache.delete(skillName); return; }
        const missing = check.missing.length ? check.missing : larkAuth.scopes;
        fileLog(`skill="${skillName}" missing: ${missing.join(", ")}`);
        api.log?.info?.(`[lark-scope-preauth] skill="${skillName}" missing: ${missing.join(", ")}`);

        const cache = skillAuthCache.get(skillName);
        const missingKey = missing.slice().sort().join("|");
        const now = Date.now();
        if (cache) {
          fileLog(`debug: skill="${skillName}" cache.missingKey="${cache.missingKey}" cur.missingKey="${missingKey}" age=${Math.round((now - cache.lastSentAtMs) / 1000)}s`);
        }
        if (cache && cache.missingKey === missingKey && (now - cache.lastSentAtMs) < 180000) {
          fileLog(`skip: skill="${skillName}" cooldown active (${Math.round((now - cache.lastSentAtMs) / 1000)}s ago)`);
          return blockRead ? { block: true, reason: `技能「${skillName}」需要飞书权限授权，上次已发送授权卡片，请完成授权后重试。` } : undefined;
        }

        const login = await startLogin(missing);
        if (login.verificationUrl) {
          const user = await getAuthedUser();
          const sent = await sendAuthCard({ skillName, missing, ...login, openId: user?.openId });
          if (sent.messageId) {
            skillAuthCache.set(skillName, { missingKey, lastSentAtMs: now });
            const mode = blockRead ? "(blocked)" : "";
            fileLog(`auth card ${mode} "${skillName}" sent msg=${sent.messageId}`);
            startWaitForAuth({ skillName, deviceCode: login.deviceCode, missingKey, openId: user?.openId, scopes: missing, ctx });
          } else {
            fileLog(`sendAuthCard failed: ${sent.error}`);
            pendingAuthNotices.push({ skillName, missing, ...login });
          }
        } else {
          fileLog(`startLogin failed "${skillName}": ${login.error}`);
        }
        // 无论发卡是否成功，只要 blockRead=true 且 scopes 缺失，一律拦截 read，
        // 防止模型拿到 SKILL.md 内容后绕过授权直接执行 skill。
        if (blockRead) {
          return { block: true, reason: `技能「${skillName}」需要飞书权限授权，已发送授权卡片，请先完成授权后重试。` };
        }
        return;
      } catch (e) {
        fileLog(`hook error: ${e?.message || e}`);
        return;
      }
    }, { priority: 80, timeoutMs: 40000 });
  },
};