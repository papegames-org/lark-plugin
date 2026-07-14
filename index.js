import { readLarkAuth } from "./parse-meta.js";
import {
  PENDING_AUTH_MAX_RETRIES,
  bumpPendingAuthNoticeFailure,
  canRetryPendingAuthNotice,
  createPendingAuthNotice,
  getPendingAuthNoticeStorePath,
  markPendingAuthNoticeExhausted,
  readPendingAuthNoticeStore,
  writePendingAuthNoticeStore,
} from "./pending-auth.js";
import {
  apiConfigRef,
  buildSkillRootsCacheKey,
  buildSkillMap,
  cachedAccountBySession,
  cachedWorkspaceBySession,
  cacheSenderId,
  checkScopes,
  fileLog,
  getAuthedUser,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  ensureFeishuRuntimeHealth,
  logCtxSnapshotOnce,
  resolvePath,
  resolveSkillReadTarget,
  resolveWorkspaceDir,
  resetRuntimeCaches,
  sendAuthCard,
  setApiConfigRef,
  setPluginApiRef,
  startLogin,
  startWaitForAuth
} from "./utils.js";

const baseDeps = {
  readLarkAuth,
  PENDING_AUTH_MAX_RETRIES,
  bumpPendingAuthNoticeFailure,
  canRetryPendingAuthNotice,
  createPendingAuthNotice,
  getPendingAuthNoticeStorePath,
  markPendingAuthNoticeExhausted,
  readPendingAuthNoticeStore,
  writePendingAuthNoticeStore,
  buildSkillRootsCacheKey,
  buildSkillMap,
  cachedAccountBySession,
  cachedWorkspaceBySession,
  cacheSenderId,
  checkScopes,
  fileLog,
  getAuthedUser,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  ensureFeishuRuntimeHealth,
  logCtxSnapshotOnce,
  resolvePath,
  resolveSkillReadTarget,
  resolveWorkspaceDir,
  resetRuntimeCaches,
  sendAuthCard,
  setApiConfigRef,
  setPluginApiRef,
  startLogin,
  startWaitForAuth,
};

export function createPluginEntry(overrides = {}) {
  const deps = { ...baseDeps, ...overrides };
  const sharedPendingAuthRuntimeByStorePath = new Map();
  const {
    readLarkAuth,
    PENDING_AUTH_MAX_RETRIES,
    bumpPendingAuthNoticeFailure,
    canRetryPendingAuthNotice,
    createPendingAuthNotice,
    getPendingAuthNoticeStorePath,
    markPendingAuthNoticeExhausted,
    readPendingAuthNoticeStore,
    writePendingAuthNoticeStore,
    buildSkillRootsCacheKey,
    buildSkillMap,
    cachedAccountBySession,
    cachedWorkspaceBySession,
    cacheSenderId,
    checkScopes,
    fileLog,
    getAuthedUser,
    getCachedSenderId,
    getDefaultSkillRoots,
    getSkillAuthCacheKey,
    ensureFeishuRuntimeHealth,
    logCtxSnapshotOnce,
    resolvePath,
    resolveSkillReadTarget,
    resolveWorkspaceDir,
    resetRuntimeCaches,
    sendAuthCard,
    setApiConfigRef,
    setPluginApiRef,
    startLogin,
    startWaitForAuth,
  } = deps;

  // ---------- 主入口（直接导出 plain entry object，无需 definePluginEntry）----------
  return {
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
    setPluginApiRef(api);
    resetRuntimeCaches();
    if (cfg.enabled === false) { fileLog("disabled by config"); return; }
    const blockRead = cfg.blockRead !== false;
    ensureFeishuRuntimeHealth().then((info) => {
      if (!info.ok) {
        api.log?.warn?.(`[lark-scope-preauth] feishu runtime unavailable: ${info.error || "unknown error"}. ${info.recoveryHint || ""}`.trim());
      }
    }).catch((error) => {
      fileLog(`runtime health check failed: ${error?.message || error}`);
    });
    const skillMapCache = new Map();
    function getSkillMapEntry(ctx) {
      const roots = Array.isArray(cfg.skillRoots) && cfg.skillRoots.length
        ? cfg.skillRoots : getDefaultSkillRoots(ctx);
      const cacheKey = buildSkillRootsCacheKey(roots);
      let entry = skillMapCache.get(cacheKey);
      if (!entry) {
        const map = buildSkillMap(roots);
        entry = { cacheKey, roots, map };
        skillMapCache.set(cacheKey, entry);
        const banner = `indexed ${map.size} SKILL.md across ${roots.length} roots (blockRead=${blockRead}) cacheKey=${cacheKey}`;
        api.log?.info?.(`[lark-scope-preauth] ${banner}`);
        fileLog(banner);
      }
      return entry;
    }

    const pendingAuthStorePath = getPendingAuthNoticeStorePath();
    fileLog(`register: pluginId=lark-scope-preauth apiConfig=${apiConfigRef ? "present" : "null"} feishuAccounts=${apiConfigRef?.channels?.feishu?.accounts ? Object.keys(apiConfigRef.channels.feishu.accounts).join(",") : "<none>"} incomingHadAccounts=${incomingHasAccounts} enabled=${cfg.enabled !== false} blockRead=${cfg.blockRead !== false} skillRoots=${Array.isArray(cfg.skillRoots) ? cfg.skillRoots.length : 0} pendingAuthStorePath=${pendingAuthStorePath}`);
    let pendingAuthRuntime = sharedPendingAuthRuntimeByStorePath.get(pendingAuthStorePath);
    if (!pendingAuthRuntime) {
      pendingAuthRuntime = {
        notices: readPendingAuthNoticeStore(pendingAuthStorePath),
        retryTimers: new Map(),
      };
      sharedPendingAuthRuntimeByStorePath.set(pendingAuthStorePath, pendingAuthRuntime);
    }
    const pendingAuthNotices = pendingAuthRuntime.notices;
    const pendingAuthRetryTimers = pendingAuthRuntime.retryTimers;
    const skillAuthCache = new Map();

    function persistPendingAuthNotices() {
      writePendingAuthNoticeStore(pendingAuthStorePath, pendingAuthNotices);
    }

    function clearPendingAuthRetryTimer(authTargetKey) {
      const timer = pendingAuthRetryTimers.get(authTargetKey);
      if (timer) {
        clearTimeout(timer);
        pendingAuthRetryTimers.delete(authTargetKey);
      }
    }

    function clearPendingAuthNotice(authTargetKey) {
      clearPendingAuthRetryTimer(authTargetKey);
      if (pendingAuthNotices.delete(authTargetKey)) {
        persistPendingAuthNotices();
      }
    }

    function updatePendingAuthNotice(authTargetKey, updates = {}) {
      const notice = pendingAuthNotices.get(authTargetKey);
      if (!notice) return null;
      const next = {
        ...notice,
        ...updates,
        updatedAt: Date.now(),
      };
      pendingAuthNotices.set(authTargetKey, next);
      persistPendingAuthNotices();
      return next;
    }

    function recordPendingAuthFailure(params) {
      const now = Date.now();
      const existing = pendingAuthNotices.get(params.authTargetKey);
      let nextNotice = null;
      if (!existing) {
        nextNotice = createPendingAuthNotice({
          ...params,
          status: "retrying",
          attemptCount: 1,
        }, now);
      } else if (existing.attemptCount >= PENDING_AUTH_MAX_RETRIES) {
        nextNotice = markPendingAuthNoticeExhausted({
          ...existing,
          ...params,
        }, params.lastError, now);
      } else if ((existing.attemptCount + 1) >= PENDING_AUTH_MAX_RETRIES) {
        nextNotice = markPendingAuthNoticeExhausted({
          ...existing,
          ...params,
        }, params.lastError, now);
      } else {
        nextNotice = bumpPendingAuthNoticeFailure(existing, params, now);
      }

      if (!nextNotice) return null;
      pendingAuthNotices.set(params.authTargetKey, nextNotice);
      persistPendingAuthNotices();
      return nextNotice;
    }

    async function retryPendingAuthNotice(authTargetKey, updates = {}) {
      const current = pendingAuthNotices.get(authTargetKey);
      if (!current) return { ok: false, reason: "missing" };
      const notice = updates.openId && updates.openId !== current.openId
        ? updatePendingAuthNotice(authTargetKey, { openId: updates.openId }) || current
        : current;

      if (!notice.openId) {
        const failedNotice = recordPendingAuthFailure({
          ...notice,
          lastError: "recipient unresolved",
        });
        return { ok: false, notice: failedNotice, reason: "recipient unresolved" };
      }

      const sent = await sendAuthCard({
        skillName: notice.skillName,
        missing: notice.missing,
        verificationUrl: notice.verificationUrl,
        userCode: notice.userCode,
        openId: notice.openId,
        accountId: notice.accountId,
      });
      if (sent.messageId) {
        clearPendingAuthNotice(authTargetKey);
        skillAuthCache.set(authTargetKey, { missingKey: notice.missingKey, lastSentAtMs: Date.now() });
        fileLog(`pendingAuth retry sent "${notice.skillName}" msg=${sent.messageId}`);
        startWaitForAuth({
          authTargetKey,
          skillName: notice.skillName,
          deviceCode: notice.deviceCode,
          missingKey: notice.missingKey,
          openId: notice.openId,
          scopes: notice.missing,
          ctx: { accountId: notice.accountId },
        });
        return { ok: true, messageId: sent.messageId };
      }

      const failedNotice = recordPendingAuthFailure({
        ...notice,
        lastError: sent.error || "send failed",
      });
      return { ok: false, notice: failedNotice, reason: sent.error || "send failed" };
    }

    function schedulePendingAuthRetry(authTargetKey) {
      const notice = pendingAuthNotices.get(authTargetKey);
      if (!notice || notice.status !== "retrying" || notice.nextRetryAt == null) return;
      if (pendingAuthRetryTimers.has(authTargetKey)) return;
      const delayMs = Math.max(0, notice.nextRetryAt - Date.now());
      const timer = setTimeout(async () => {
        pendingAuthRetryTimers.delete(authTargetKey);
        try {
          const result = await retryPendingAuthNotice(authTargetKey);
          if (!result.ok) {
            const latest = pendingAuthNotices.get(authTargetKey);
            if (latest?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
          }
        } catch (error) {
          fileLog(`pendingAuth retry failed authTargetKey="${authTargetKey}" error=${error?.message || error}`);
          const latest = pendingAuthNotices.get(authTargetKey);
          if (latest?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
        }
      }, delayMs);
      pendingAuthRetryTimers.set(authTargetKey, timer);
    }

    for (const [authTargetKey, notice] of pendingAuthNotices) {
      if (notice.status === "retrying" && !pendingAuthRetryTimers.has(authTargetKey)) {
        schedulePendingAuthRetry(authTargetKey);
      }
    }
    if (pendingAuthNotices.size > 0) {
      fileLog(`pendingAuth restored notices=${pendingAuthNotices.size}`);
    }

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
      const senderId = getCachedSenderId(ctx);
      if (senderId) {
        cacheSenderId(ctx, senderId);
        fileLog(`senderId: cached from before_prompt_build sessionId=${ctx?.sessionId || "<none>"} -> ${senderId}`);
      }
    });

    api.on("message_received", async (event, ctx) => {
      const acc = event?.accountId || ctx?.accountId || ctx?.account || null;
      const sid = ctx?.sessionId || event?.sessionId || null;
      const skey = ctx?.sessionKey || event?.sessionKey || null;
      const senderId = event?.senderId || ctx?.senderId || event?.sender?.id || event?.senderOpenId || ctx?.senderOpenId || null;
      fileLog(`message_received accountId=${acc || "<none>"} sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"} eventKeys=${event ? JSON.stringify(Object.keys(event)) : "null"}`);
      if (acc) {
        if (sid) cachedAccountBySession.set(sid, acc);
        if (skey) cachedAccountBySession.set(skey, acc);
      }
      if (senderId) {
        cacheSenderId({ sessionId: sid, sessionKey: skey }, senderId);
        fileLog(`senderId: cached from message_received sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"} -> ${senderId}`);
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      try {
        logCtxSnapshotOnce(ctx);
        fileLog(`hook: tool=${event?.toolName || ""} channel=${ctx?.channel || ""} path=${event?.params?.path || ""}`);
        if (event.toolName !== "read") return;
        fileLog(`hook: read-enter rawPath=${event?.params?.path || ""} cwd=${ctx?.cwd || ""}`);
        if (ctx && ctx.channel && ctx.channel !== "feishu") return;
        const rawPath = event.params?.path;
        const skillCommandName = typeof ctx?.skillCommand?.skillName === "string" && ctx.skillCommand.skillName.trim()
          ? ctx.skillCommand.skillName.trim()
          : null;
        if (!rawPath && !skillCommandName) return;
        const wsDir = resolveWorkspaceDir(ctx);
        const directTarget = resolveSkillReadTarget(rawPath, ctx?.cwd, wsDir);
        if (!ctx?.senderId) {
          const cachedSenderId = getCachedSenderId(ctx);
          if (cachedSenderId) {
            try { ctx.senderId = cachedSenderId; } catch {}
            fileLog(`senderId: restored for before_tool_call sessionId=${ctx?.sessionId || "<none>"} -> ${cachedSenderId}`);
          }
        }
        const skillMapEntry = getSkillMapEntry(ctx);
        const abs = directTarget?.abs || resolvePath(rawPath, ctx?.cwd, wsDir);
        let skillName = skillMapEntry.map.get(abs) || directTarget?.skillName || skillCommandName || null;
        let skillPath = abs;
        if (!skillPath && skillCommandName) {
          for (const [candidatePath, candidateSkillName] of skillMapEntry.map.entries()) {
            if (candidateSkillName === skillCommandName) {
              skillPath = candidatePath;
              break;
            }
          }
        }
        if (!skillName && Array.isArray(ctx?.skillsSnapshot?.resolvedSkills)) {
          const matchedSkill = ctx.skillsSnapshot.resolvedSkills.find((item) => item?.name && item.name === directTarget?.skillName);
          if (matchedSkill?.name) skillName = matchedSkill.name;
        }
        if (!skillName) {
          fileLog(`debug: no match for abs="${abs}" rawPath="${rawPath}" in skillMap (size=${skillMapEntry.map.size}, keys.examples=${[...skillMapEntry.map.keys()].slice(0, 3).join(", ")})`);
          return;
        }
        if (!skillPath && skillName) {
          for (const [candidatePath, candidateSkillName] of skillMapEntry.map.entries()) {
            if (candidateSkillName === skillName) {
              skillPath = candidatePath;
              break;
            }
          }
        }
        if (!skillPath) {
          fileLog(`debug: matched skillName="${skillName}" but could not resolve SKILL.md path`);
          return;
        }
        const larkAuth = readLarkAuth(skillPath);
        if (!larkAuth || larkAuth.identity !== "user" || !larkAuth.scopes.length) return;
        const authTargetKey = getSkillAuthCacheKey(skillPath, ctx);

        const runtime = await ensureFeishuRuntimeHealth();
        if (!runtime.ok) {
          const reason = `技能「${skillName}」依赖的飞书运行时当前不可用，无法完成权限校验。${runtime.recoveryHint || "请补齐 Feishu 应用凭据后重试。"}`;
          fileLog(`runtime blocked skill="${skillName}" reason=${reason}`);
          return blockRead ? { block: true, reason } : undefined;
        }

        const check = await checkScopes(larkAuth.scopes, ctx);
        if (check.ok) {
          clearPendingAuthNotice(authTargetKey);
          skillAuthCache.delete(authTargetKey);
          return;
        }
        const missing = check.missing.length ? check.missing : larkAuth.scopes;
        fileLog(`skill="${skillName}" missing: ${missing.join(", ")}`);
        api.log?.info?.(`[lark-scope-preauth] skill="${skillName}" missing: ${missing.join(", ")}`);
        const now = Date.now();

        let resolvedUser = null;
        const pendingNotice = pendingAuthNotices.get(authTargetKey);
        if (pendingNotice) {
          if (pendingNotice.status === "exhausted") {
            fileLog(`pendingAuth exhausted notice reopened authTargetKey="${authTargetKey}"`);
            clearPendingAuthNotice(authTargetKey);
          }
        }

        const resumedPendingNotice = pendingAuthNotices.get(authTargetKey);
        if (resumedPendingNotice) {
          if (!resumedPendingNotice.openId) {
            resolvedUser = await getAuthedUser(ctx).catch(() => null);
            if (resolvedUser?.openId) updatePendingAuthNotice(authTargetKey, { openId: resolvedUser.openId });
          }
          if (canRetryPendingAuthNotice(resumedPendingNotice, { nowMs: now })) {
            const retried = await retryPendingAuthNotice(authTargetKey, { openId: resolvedUser?.openId });
            if (retried.ok) {
              return blockRead ? { block: true, reason: `技能「${skillName}」需要飞书权限授权，已重新发送授权卡片，请完成授权后重试。` } : undefined;
            }
            const latestNotice = pendingAuthNotices.get(authTargetKey);
            if (latestNotice?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
          }
          const latestPendingNotice = pendingAuthNotices.get(authTargetKey);
          if (latestPendingNotice) {
            const reason = latestPendingNotice.status === "exhausted"
              ? `技能「${skillName}」需要飞书权限授权，但授权提醒连续发送失败，请稍后重试或执行诊断命令排查。`
              : `技能「${skillName}」需要飞书权限授权，授权提醒发送失败，系统会自动重试，请稍后重试。`;
            return blockRead ? { block: true, reason } : undefined;
          }
        }

        const cache = skillAuthCache.get(authTargetKey);
        const missingKey = missing.slice().sort().join("|");
        if (cache) {
          fileLog(`debug: authTargetKey="${authTargetKey}" cache.missingKey="${cache.missingKey}" cur.missingKey="${missingKey}" age=${Math.round((now - cache.lastSentAtMs) / 1000)}s`);
        }
        if (cache && cache.missingKey === missingKey && (now - cache.lastSentAtMs) < 180000) {
          fileLog(`skip: authTargetKey="${authTargetKey}" cooldown active (${Math.round((now - cache.lastSentAtMs) / 1000)}s ago)`);
          return blockRead ? { block: true, reason: `技能「${skillName}」需要飞书权限授权，上次已发送授权卡片，请完成授权后重试。` } : undefined;
        }

        const login = await startLogin(missing, ctx);
        if (login.verificationUrl) {
          const user = resolvedUser || await getAuthedUser(ctx);
          const sent = await sendAuthCard({
            skillName,
            missing,
            ...login,
            openId: user?.openId,
            accountId: ctx?.accountId || ctx?.account || "unknown",
          });
          if (sent.messageId) {
            clearPendingAuthNotice(authTargetKey);
            skillAuthCache.set(authTargetKey, { missingKey, lastSentAtMs: now });
            const mode = blockRead ? "(blocked)" : "";
            fileLog(`auth card ${mode} "${skillName}" sent msg=${sent.messageId}`);
            startWaitForAuth({ authTargetKey, skillName, deviceCode: login.deviceCode, missingKey, openId: user?.openId, scopes: missing, ctx });
          } else {
            fileLog(`sendAuthCard failed: ${sent.error}`);
            const notice = recordPendingAuthFailure({
              authTargetKey,
              skillName,
              skillPath,
              accountId: ctx?.accountId || ctx?.account || "unknown",
              openId: user?.openId || null,
              missing,
              missingKey,
              verificationUrl: login.verificationUrl,
              userCode: login.userCode,
              deviceCode: login.deviceCode,
              lastError: sent.error || "send failed",
            });
            if (notice?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
          }
        } else {
          fileLog(`startLogin failed "${skillName}": ${login.error}`);
        }
        // 无论发卡是否成功，只要 blockRead=true 且 scopes 缺失，一律拦截 read，
        // 防止模型拿到 SKILL.md 内容后绕过授权直接执行 skill。
        if (blockRead) {
          const reason = pendingAuthNotices.has(authTargetKey)
            ? `技能「${skillName}」需要飞书权限授权，授权提醒发送失败，系统会自动重试，请稍后重试。`
            : `技能「${skillName}」需要飞书权限授权，已发送授权卡片，请先完成授权后重试。`;
          return { block: true, reason };
        }
        return;
      } catch (e) {
        fileLog(`hook error: ${e?.message || e}`);
        return;
      }
    }, { priority: 80, timeoutMs: 40000 });
    },
  };
}

export default createPluginEntry();
