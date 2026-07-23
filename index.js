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
  checkApplicationAuthorization,
  checkScopes,
  checkUserAuthorization,
  checkUserAuthorizationByLarkCli,
  fileLog,
  getAuthedUser,
  getAccountId,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  inferSenderIdFromCtx,
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
  checkApplicationAuthorization,
  checkScopes,
  checkUserAuthorization,
  checkUserAuthorizationByLarkCli,
  fileLog,
  getAuthedUser,
  getAccountId,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  inferSenderIdFromCtx,
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
    checkApplicationAuthorization,
    checkScopes,
    checkUserAuthorization,
    checkUserAuthorizationByLarkCli,
    fileLog,
    getAuthedUser,
    getAccountId,
    getCachedSenderId,
    getDefaultSkillRoots,
    getSkillAuthCacheKey,
    inferSenderIdFromCtx,
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

  function safeJson(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, current) => {
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      if (typeof current === "string") {
        return current.length > 240 ? `${current.slice(0, 240)}…` : current;
      }
      if (Array.isArray(current) && current.length > 12) {
        return [...current.slice(0, 12), `…(+${current.length - 12} more)`];
      }
      return current;
    });
  }

  function buildHookDebugSummary(event, ctx) {
    return {
      eventKeys: event ? Object.keys(event) : null,
      ctxKeys: ctx ? Object.keys(ctx) : null,
      eventSenderId: event?.senderId || event?.senderOpenId || event?.sender?.id || event?.sender?.open_id || event?.sender?.openId || null,
      ctxSenderId: ctx?.senderId || ctx?.senderOpenId || ctx?.openId || null,
      eventTrigger: event?.trigger || null,
      ctxTrigger: ctx?.trigger || null,
      eventSkillCommand: event?.skillCommand || null,
      ctxSkillCommand: ctx?.skillCommand || null,
      eventSkillName: event?.skillName || null,
      ctxSkillName: ctx?.skillName || null,
      eventParams: event?.params || null,
      ctxMessageProvider: ctx?.messageProvider || null,
      ctxChannel: ctx?.channel || null,
      ctxChannelId: ctx?.channelId || null,
      ctxAccountId: ctx?.accountId || ctx?.account || null,
      ctxSessionId: ctx?.sessionId || null,
      ctxSessionKey: ctx?.sessionKey || null,
      ctxTraceKeys: ctx?.trace ? Object.keys(ctx.trace) : null,
      ctxTraceSkillCommand: ctx?.trace?.skillCommand || null,
      ctxTraceTrigger: ctx?.trace?.trigger || null,
      ctxSkillsSnapshotNames: Array.isArray(ctx?.skillsSnapshot?.resolvedSkills)
        ? ctx.skillsSnapshot.resolvedSkills.map((item) => item?.name).filter(Boolean)
        : null,
      eventSkillsSnapshotNames: Array.isArray(event?.skillsSnapshot?.resolvedSkills)
        ? event.skillsSnapshot.resolvedSkills.map((item) => item?.name).filter(Boolean)
        : null,
    };
  }

  function normalizeSkillName(value) {
    return typeof value === "string" && value.trim()
      ? value.trim()
      : null;
  }

  function getResolvedSkillNames(snapshot) {
    if (!Array.isArray(snapshot?.resolvedSkills)) return [];
    return snapshot.resolvedSkills
      .map((item) => normalizeSkillName(item?.name || item?.skillName))
      .filter(Boolean);
  }

  function collectSkillNameCandidates(event, ctx, directTarget) {
    return [...new Set([
      normalizeSkillName(directTarget?.skillName),
      normalizeSkillName(ctx?.skillCommand?.skillName),
      normalizeSkillName(event?.skillCommand?.skillName),
      normalizeSkillName(ctx?.trace?.skillCommand?.skillName),
      normalizeSkillName(event?.trace?.skillCommand?.skillName),
      normalizeSkillName(ctx?.skillName),
      normalizeSkillName(event?.skillName),
      ...getResolvedSkillNames(ctx?.skillsSnapshot),
      ...getResolvedSkillNames(event?.skillsSnapshot),
      ...getResolvedSkillNames(ctx?.trace?.skillsSnapshot),
      ...getResolvedSkillNames(event?.trace?.skillsSnapshot),
    ].filter(Boolean))];
  }

  function hasEarlySkillGateEnabled(config) {
    return config?.plugins?.entries?.["openclaw-skill-runtime"]?.hooks
      ?.allowConversationAccess === true;
  }

  // ---------- 主入口（直接导出 plain entry object，无需 definePluginEntry）----------
  return {
    id: "openclaw-skill-runtime",
    name: "OpenClaw Skill Runtime",
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
    const userAuthProvider = cfg.userAuthProvider === "context" ? "context" : "lark-cli";
    setPluginApiRef(api);
    resetRuntimeCaches();
    if (cfg.enabled === false) { fileLog("disabled by config"); return; }
    if (!hasEarlySkillGateEnabled(api.config)) {
      const recoveryHint = "Early skill authorization is disabled. Run: "
        + "openclaw config set plugins.entries.openclaw-skill-runtime.hooks.allowConversationAccess true "
        + "and restart the OpenClaw Gateway.";
      api.log?.warn?.(`[openclaw-skill-runtime] ${recoveryHint}`);
      fileLog(`configuration warning: ${recoveryHint}`);
    }
    const blockRead = cfg.blockRead !== false;
    ensureFeishuRuntimeHealth().then((info) => {
      if (!info.ok) {
        api.log?.warn?.(`[openclaw-skill-runtime] feishu runtime unavailable: ${info.error || "unknown error"}. ${info.recoveryHint || ""}`.trim());
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
        api.log?.info?.(`[openclaw-skill-runtime] ${banner}`);
        fileLog(banner);
      }
      return entry;
    }

    const pendingAuthStorePath = getPendingAuthNoticeStorePath();
    fileLog(`register: pluginId=openclaw-skill-runtime apiConfig=${apiConfigRef ? "present" : "null"} feishuAccounts=${apiConfigRef?.channels?.feishu?.accounts ? Object.keys(apiConfigRef.channels.feishu.accounts).join(",") : "<none>"} incomingHadAccounts=${incomingHasAccounts} enabled=${cfg.enabled !== false} blockRead=${cfg.blockRead !== false} skillRoots=${Array.isArray(cfg.skillRoots) ? cfg.skillRoots.length : 0} pendingAuthStorePath=${pendingAuthStorePath}`);
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
    const explicitSkillBySession = new Map();
    // Keep a verified explicit Skill gate for the rest of the session. This is
    // only populated after its own before_agent_run authorization preflight
    // failed, so it cannot turn arbitrary tool calls into a broad interceptor.
    const blockedExplicitSkillBySession = new Map();

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

      if (!notice.openId && !notice.chatId) {
        const failedNotice = recordPendingAuthFailure({
          ...notice,
          lastError: "recipient unresolved",
        });
        return { ok: false, notice: failedNotice, reason: "recipient unresolved" };
      }

      const sent = await sendAuthCard({
        skillName: notice.skillName,
        missing: notice.missing,
        declaredScopes: notice.declaredScopes,
        verificationUrl: notice.verificationUrl,
        userCode: notice.userCode,
        openId: notice.openId,
        chatId: notice.chatId,
        accountId: notice.accountId,
        identity: notice.identity,
        checkPhase: notice.checkPhase,
        ctx: { accountId: notice.accountId, channelId: notice.chatId || null },
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
          identity: notice.identity,
          checkPhase: notice.checkPhase,
          userAuthProvider: notice.userAuthProvider,
          larkCliPath: notice.larkCliPath,
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

    function resolveExplicitSkillName(prompt) {
      if (typeof prompt !== "string") return null;
      const match = /(?:^|\r?\n)Use the "([^"\r\n]+)" skill for this request\.(?:\r?\n|$)/u.exec(prompt);
      return normalizeSkillName(match?.[1]);
    }

    function resolveExplicitSkillNameFromMessage(event) {
      const candidates = [
        event?.text,
        event?.content,
        event?.message?.text,
        event?.message?.content,
      ];
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const command = /^\s*\/skill\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/u.exec(candidate)
          || /^\s*执行\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:这个)?(?:skill|技能)?[。！!]*\s*$/iu.exec(candidate)
          || /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/u.exec(candidate);
        const skillName = normalizeSkillName(command?.[1]);
        if (skillName) return skillName;
      }
      return null;
    }

    function resolveExplicitSkillNameFromPromptBuildEvent(event) {
      const candidates = [event?.prompt];
      if (Array.isArray(event?.messages)) {
        for (const message of event.messages) {
          if (typeof message === "string") candidates.push(message);
          else if (message && typeof message === "object") {
            candidates.push(message.text, message.content, message?.content?.text);
          }
        }
      }
      for (const candidate of candidates) {
        const skillName = resolveExplicitSkillNameFromMessage({ text: candidate });
        if (skillName) return skillName;
      }
      return null;
    }

    function getExplicitSkillCacheKeys(ctx) {
      const keys = [ctx?.sessionId, ctx?.sessionKey];
      for (const channelKey of [ctx?.channelId, ctx?.conversationId]) {
        if (typeof channelKey === "string" && channelKey) keys.push(`channel:${channelKey}`);
      }
      return [...new Set(keys.filter((key) => typeof key === "string" && key))];
    }

    function cacheExplicitSkillName(ctx, skillName) {
      if (!skillName) return;
      for (const key of getExplicitSkillCacheKeys(ctx)) explicitSkillBySession.set(key, skillName);
    }

    function takeCachedExplicitSkillName(ctx) {
      for (const key of getExplicitSkillCacheKeys(ctx)) {
        const skillName = explicitSkillBySession.get(key);
        if (!skillName) continue;
        for (const clearKey of getExplicitSkillCacheKeys(ctx)) explicitSkillBySession.delete(clearKey);
        return skillName;
      }
      return null;
    }

    function cacheBlockedExplicitSkill(ctx, target) {
      if (!target?.skillName || !target?.skillPath) return;
      for (const key of [ctx?.sessionId, ctx?.sessionKey]) {
        if (typeof key === "string" && key) blockedExplicitSkillBySession.set(key, target);
      }
    }

    function getBlockedExplicitSkill(ctx) {
      for (const key of [ctx?.sessionId, ctx?.sessionKey]) {
        if (typeof key !== "string" || !key) continue;
        const target = blockedExplicitSkillBySession.get(key);
        if (target) return target;
      }
      return null;
    }

    function clearBlockedExplicitSkill(ctx) {
      for (const key of [ctx?.sessionId, ctx?.sessionKey]) {
        if (typeof key === "string" && key) blockedExplicitSkillBySession.delete(key);
      }
    }

    function resolveSkillPathByName(skillMapEntry, skillName) {
      if (!skillName) return null;
      for (const [skillPath, candidateSkillName] of skillMapEntry.map.entries()) {
        if (candidateSkillName === skillName) return skillPath;
      }
      return null;
    }

    function normalizeAuthDeclaration(input) {
      const scopes = Array.isArray(input?.scopes)
        ? [...new Set(input.scopes.map((scope) => typeof scope === "string" ? scope.trim() : "").filter(Boolean))]
        : [];
      if (scopes.length === 0) return null;
      return {
        identity: input?.identity === "app" ? "app" : "user",
        scopes,
      };
    }

    function resolveToolAuth(toolName) {
      if (!toolName || !cfg.toolAuth || typeof cfg.toolAuth !== "object") return null;
      return normalizeAuthDeclaration(cfg.toolAuth[toolName]);
    }

    function buildAuthContext(event, ctx) {
      const authCtx = {
        ...(ctx || {}),
      };
      const accountId = event?.accountId || ctx?.accountId || ctx?.account || null;
      const channelId = event?.channelId || ctx?.channelId || null;
      const senderId = event?.senderId || event?.senderOpenId || event?.sender?.id || event?.sender?.open_id || event?.sender?.openId || getCachedSenderId(ctx) || inferSenderIdFromCtx(ctx) || null;
      if (accountId) authCtx.accountId = accountId;
      if (channelId) authCtx.channelId = channelId;
      if (senderId) {
        authCtx.senderId = senderId;
        cacheSenderId(authCtx, senderId);
      }
      return authCtx;
    }

    async function preflightAuthDeclaration({ targetName, targetPath, larkAuth, ctx }) {
      if (!larkAuth || !larkAuth.scopes.length) return null;
      const authTargetKey = getSkillAuthCacheKey(targetPath, ctx);

      const runtime = await ensureFeishuRuntimeHealth();
      if (!runtime.ok) {
        const reason = `技能「${targetName}」依赖的飞书运行时当前不可用，无法完成权限校验。${runtime.recoveryHint || "请补齐 Feishu 应用凭据后重试。"}`;
        fileLog(`runtime blocked target="${targetName}" reason=${reason}`);
        return blockRead ? reason : null;
      }

      const appScopeCheck = await checkApplicationAuthorization(larkAuth.scopes, larkAuth.identity, ctx);
      let authPhase = "app_scope";
      let check = {
        ok: appScopeCheck.ok,
        missing: [...(appScopeCheck.missing || []), ...(appScopeCheck.incompatible || [])],
      };
      if (appScopeCheck.ok && larkAuth.identity === "user") {
        authPhase = "user_grant";
        check = userAuthProvider === "lark-cli"
          ? await checkUserAuthorizationByLarkCli(larkAuth.scopes, ctx, {
            larkCliPath: cfg.larkCliPath,
          })
          : await checkUserAuthorization(larkAuth.scopes, ctx);
      }
      if (check.ok) {
        clearPendingAuthNotice(authTargetKey);
        skillAuthCache.delete(authTargetKey);
        return null;
      }
      const missing = check.missing.length ? check.missing : larkAuth.scopes;
      fileLog(`target="${targetName}" missing phase=${authPhase} identity=${larkAuth.identity}: ${missing.join(", ")}`);
      api.log?.info?.(`[openclaw-skill-runtime] target="${targetName}" missing phase=${authPhase} identity=${larkAuth.identity}: ${missing.join(", ")}`);
      const now = Date.now();
      const resolvedAccountId = getAccountId(ctx);

      let resolvedUser = null;
      const pendingNotice = pendingAuthNotices.get(authTargetKey);
      if (pendingNotice?.status === "exhausted") {
        fileLog(`pendingAuth exhausted notice reopened authTargetKey="${authTargetKey}"`);
        clearPendingAuthNotice(authTargetKey);
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
            return blockRead ? `技能「${targetName}」需要飞书权限授权，已重新发送授权卡片，请完成授权后重试。` : null;
          }
          const latestNotice = pendingAuthNotices.get(authTargetKey);
          if (latestNotice?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
        }
        const latestPendingNotice = pendingAuthNotices.get(authTargetKey);
        if (latestPendingNotice) {
          const reason = latestPendingNotice.status === "exhausted"
            ? `技能「${targetName}」需要飞书权限授权，但授权提醒连续发送失败，请稍后重试或执行诊断命令排查。`
            : `技能「${targetName}」需要飞书权限授权，授权提醒发送失败，系统会自动重试，请稍后重试。`;
          return blockRead ? reason : null;
        }
      }

      const cache = skillAuthCache.get(authTargetKey);
      const missingKey = `${larkAuth.identity}:${authPhase}:${missing.slice().sort().join("|")}`;
      if (cache) {
        fileLog(`debug: authTargetKey="${authTargetKey}" cache.missingKey="${cache.missingKey}" cur.missingKey="${missingKey}" age=${Math.round((now - cache.lastSentAtMs) / 1000)}s`);
      }
      if (cache && cache.missingKey === missingKey && (now - cache.lastSentAtMs) < 180000) {
        fileLog(`skip: authTargetKey="${authTargetKey}" cooldown active (${Math.round((now - cache.lastSentAtMs) / 1000)}s ago)`);
        return blockRead ? `技能「${targetName}」需要飞书权限授权，上次已发送授权卡片，请完成授权后重试。` : null;
      }

      const login = await startLogin(missing, ctx, {
        identity: larkAuth.identity,
        checkPhase: authPhase,
        redirectUri: cfg.userOAuthRedirectUri,
        userAuthProvider,
        larkCliPath: cfg.larkCliPath,
      });
      if (login.verificationUrl) {
        const user = resolvedUser || await getAuthedUser(ctx);
        const chatId = typeof ctx?.channelId === "string" && /^oc_[A-Za-z0-9]/.test(ctx.channelId.trim())
          ? ctx.channelId.trim()
          : null;
        const sent = await sendAuthCard({
          skillName: targetName,
          missing,
          declaredScopes: larkAuth.scopes,
          ...login,
          openId: user?.openId,
          chatId,
          accountId: resolvedAccountId,
          identity: larkAuth.identity,
          checkPhase: authPhase,
          ctx,
        });
        if (sent.messageId) {
          clearPendingAuthNotice(authTargetKey);
          skillAuthCache.set(authTargetKey, { missingKey, lastSentAtMs: now });
          const mode = blockRead ? "(blocked)" : "";
          fileLog(`auth card ${mode} "${targetName}" sent msg=${sent.messageId}`);
          startWaitForAuth({
            authTargetKey,
            skillName: targetName,
            deviceCode: login.deviceCode,
            missingKey,
            openId: user?.openId,
            scopes: missing,
            ctx,
            identity: larkAuth.identity,
            checkPhase: authPhase,
            userAuthProvider,
            larkCliPath: cfg.larkCliPath,
          });
        } else {
          fileLog(`sendAuthCard failed: ${sent.error}`);
          const notice = recordPendingAuthFailure({
            authTargetKey,
            skillName: targetName,
            skillPath: targetPath,
            accountId: resolvedAccountId,
            openId: user?.openId || null,
            chatId,
            identity: larkAuth.identity,
            checkPhase: authPhase,
            missing,
            declaredScopes: larkAuth.scopes,
            missingKey,
            verificationUrl: login.verificationUrl,
            userCode: login.userCode,
            deviceCode: login.deviceCode,
            userAuthProvider,
            larkCliPath: cfg.larkCliPath,
            lastError: sent.error || "send failed",
          });
          if (notice?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
        }
      } else {
        fileLog(`startLogin failed "${targetName}": ${login.error}`);
      }
      if (!blockRead) return null;
      return pendingAuthNotices.has(authTargetKey)
        ? `技能「${targetName}」需要飞书权限授权，授权提醒发送失败，系统会自动重试，请稍后重试。`
        : `技能「${targetName}」需要飞书权限授权，已发送授权卡片，请先完成授权后重试。`;
    }

    async function preflightSkillAuth({ skillName, skillPath, ctx }) {
      const larkAuth = readLarkAuth(skillPath);
      return preflightAuthDeclaration({
        targetName: skillName,
        targetPath: skillPath,
        larkAuth,
        ctx,
      });
    }

    api.on("before_prompt_build", async (event, ctx) => {
      if (ctx?.workspaceDir && ctx?.sessionId) {
        cachedWorkspaceBySession.set(ctx.sessionId, ctx.workspaceDir);
      }
      fileLog(`before_prompt_build ctx keys=${ctx ? JSON.stringify(Object.keys(ctx)) : "null"} accountId=${ctx?.accountId || "<none>"} account=${ctx?.account || "<none>"} channel=${ctx?.channel || "<none>"} messageProvider=${ctx?.messageProvider || "<none>"} channelId=${ctx?.channelId || "<none>"}`);
      fileLog(`before_prompt_build summary=${safeJson(buildHookDebugSummary(event, ctx))}`);
      const acc = ctx?.accountId || ctx?.account || null;
      if (acc && ctx?.sessionId) {
        cachedAccountBySession.set(ctx.sessionId, acc);
        fileLog(`accountId: cached from before_prompt_build sessionId=${ctx.sessionId} -> ${acc}`);
      }
      const senderId = getCachedSenderId(ctx);
      if (senderId) {
        cacheSenderId(ctx, senderId);
        fileLog(`senderId: cached from before_prompt_build sessionId=${ctx?.sessionId || "<none>"} -> ${senderId}`);
      } else {
        const inferredSenderId = inferSenderIdFromCtx(ctx);
        if (inferredSenderId) {
          cacheSenderId(ctx, inferredSenderId);
          fileLog(`senderId: inferred from before_prompt_build sessionId=${ctx?.sessionId || "<none>"} channelId=${ctx?.channelId || "<none>"} -> ${inferredSenderId}`);
        }
      }
      const explicitSkillName = resolveExplicitSkillNameFromPromptBuildEvent(event);
      if (!explicitSkillName) return;
      const skillMapEntry = getSkillMapEntry(ctx);
      if (!resolveSkillPathByName(skillMapEntry, explicitSkillName)) {
        fileLog(`before_prompt_build: explicit skill="${explicitSkillName}" not found in skillMap size=${skillMapEntry.map.size}`);
        return;
      }
      cacheExplicitSkillName(ctx, explicitSkillName);
      fileLog(`before_prompt_build: cached explicit skill="${explicitSkillName}" sessionId=${ctx?.sessionId || "<none>"} sessionKey=${ctx?.sessionKey || "<none>"}`);
    });

    api.on("message_received", async (event, ctx) => {
      const acc = event?.accountId || ctx?.accountId || ctx?.account || null;
      const sid = ctx?.sessionId || event?.sessionId || null;
      const skey = ctx?.sessionKey || event?.sessionKey || null;
      const senderId = event?.senderId || ctx?.senderId || event?.sender?.id || event?.senderOpenId || ctx?.senderOpenId || null;
      fileLog(`message_received accountId=${acc || "<none>"} sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"} eventKeys=${event ? JSON.stringify(Object.keys(event)) : "null"}`);
      fileLog(`message_received summary=${safeJson(buildHookDebugSummary(event, ctx))}`);
      if (acc) {
        if (sid) cachedAccountBySession.set(sid, acc);
        if (skey) cachedAccountBySession.set(skey, acc);
      }
      if (senderId) {
        cacheSenderId({ sessionId: sid, sessionKey: skey }, senderId);
        fileLog(`senderId: cached from message_received sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"} -> ${senderId}`);
      }
      const explicitSkillName = resolveExplicitSkillNameFromMessage(event);
      if (!explicitSkillName) return;
      const skillMapEntry = getSkillMapEntry(ctx);
      if (!resolveSkillPathByName(skillMapEntry, explicitSkillName)) {
        fileLog(`message_received: explicit skill="${explicitSkillName}" not found in skillMap size=${skillMapEntry.map.size}`);
        return;
      }
      cacheExplicitSkillName(ctx, explicitSkillName);
      fileLog(`message_received: cached explicit skill="${explicitSkillName}" sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"}`);
    });

    api.on("before_agent_run", async (event, ctx) => {
      try {
        if ((ctx?.messageProvider || ctx?.channel) !== "feishu") return;
        const skillName = resolveExplicitSkillName(event?.prompt) || takeCachedExplicitSkillName(ctx);
        if (!skillName) return;
        const authCtx = buildAuthContext(event, ctx);
        const skillMapEntry = getSkillMapEntry(authCtx);
        const skillPath = resolveSkillPathByName(skillMapEntry, skillName);
        if (!skillPath) {
          fileLog(`before_agent_run: explicit skill="${skillName}" not found in skillMap size=${skillMapEntry.map.size}`);
          return;
        }
        fileLog(`before_agent_run: explicit skill="${skillName}" path="${skillPath}" runId=${ctx?.runId || "<none>"}`);
        const reason = await preflightSkillAuth({ skillName, skillPath, ctx: authCtx });
        if (!reason) return;
        cacheBlockedExplicitSkill(authCtx, {
          skillName,
          skillPath,
          accountId: authCtx.accountId || null,
          senderId: authCtx.senderId || null,
        });
        return {
          outcome: "block",
          reason: `skill authorization required: ${skillName}`,
          message: reason,
          category: "skill_authorization",
          metadata: { skillName },
        };
      } catch (error) {
        const reason = `技能权限预检失败：${error?.message || error}`;
        fileLog(`before_agent_run error: ${error?.message || error}`);
        return blockRead ? {
          outcome: "block",
          reason: "skill authorization preflight failed",
          message: reason,
          category: "skill_authorization_error",
        } : undefined;
      }
    }, { priority: 80, timeoutMs: 40000 });

    api.on("before_tool_call", async (event, ctx) => {
      try {
        logCtxSnapshotOnce(ctx);
        fileLog(`hook: tool=${event?.toolName || ""} channel=${ctx?.channel || ""} path=${event?.params?.path || ""}`);
        fileLog(`before_tool_call summary=${safeJson(buildHookDebugSummary(event, ctx))}`);
        if (ctx && ctx.channel && ctx.channel !== "feishu") return;
        const blockedExplicitSkill = getBlockedExplicitSkill(ctx);
        if (blockedExplicitSkill) {
          const authCtx = buildAuthContext(event, {
            ...(ctx || {}),
            accountId: ctx?.accountId || blockedExplicitSkill.accountId || null,
            senderId: ctx?.senderId || blockedExplicitSkill.senderId || null,
          });
          const reason = await preflightSkillAuth({ ...blockedExplicitSkill, ctx: authCtx });
          if (reason) {
            fileLog(`before_tool_call: blocked explicit skill session target="${blockedExplicitSkill.skillName}" tool=${event?.toolName || "<none>"}`);
            return { block: true, reason };
          }
          clearBlockedExplicitSkill(ctx);
        }
        const cachedExplicitSkillName = takeCachedExplicitSkillName(ctx);
        if (cachedExplicitSkillName) {
          const authCtx = buildAuthContext(event, ctx);
          const skillMapEntry = getSkillMapEntry(authCtx);
          const skillPath = resolveSkillPathByName(skillMapEntry, cachedExplicitSkillName);
          if (!skillPath) {
            fileLog(`before_tool_call: cached explicit skill="${cachedExplicitSkillName}" not found in skillMap size=${skillMapEntry.map.size}`);
          } else {
            const reason = await preflightSkillAuth({ skillName: cachedExplicitSkillName, skillPath, ctx: authCtx });
            if (reason) {
              cacheBlockedExplicitSkill(authCtx, {
                skillName: cachedExplicitSkillName,
                skillPath,
                accountId: authCtx.accountId || null,
                senderId: authCtx.senderId || null,
              });
              fileLog(`before_tool_call: blocked cached explicit skill="${cachedExplicitSkillName}" tool=${event?.toolName || "<none>"}`);
              return { block: true, reason };
            }
          }
        }
        const rawPath = event.params?.path;
        const wsDir = resolveWorkspaceDir(ctx);
        const directTarget = resolveSkillReadTarget(rawPath, ctx?.cwd, wsDir);
        const skillNameCandidates = collectSkillNameCandidates(event, ctx, directTarget);
        const isReadTool = event.toolName === "read";
        const toolAuth = !isReadTool ? resolveToolAuth(event?.toolName) : null;
        if (!isReadTool && skillNameCandidates.length === 0 && !toolAuth) return;
        if (isReadTool) {
          fileLog(`hook: read-enter rawPath=${event?.params?.path || ""} cwd=${ctx?.cwd || ""}`);
        } else if (toolAuth && skillNameCandidates.length === 0) {
          fileLog(`hook: configured-tool-auth-enter tool=${event?.toolName || ""}`);
        } else {
          fileLog(`hook: skill-runtime-enter tool=${event?.toolName || ""} skillCandidates=${skillNameCandidates.join(",") || "<none>"}`);
        }
        if (!rawPath && skillNameCandidates.length === 0 && !toolAuth) return;
        if (!ctx?.senderId) {
          const senderFromEvent = event?.senderId || event?.senderOpenId || event?.sender?.id || event?.sender?.open_id || event?.sender?.openId || null;
          if (typeof senderFromEvent === "string" && /^ou_[A-Za-z0-9]/.test(senderFromEvent.trim())) {
            const normalized = senderFromEvent.trim();
            try { ctx.senderId = normalized; } catch {}
            cacheSenderId(ctx, normalized);
            fileLog(`senderId: restored from event for before_tool_call sessionId=${ctx?.sessionId || "<none>"} -> ${normalized}`);
          }
        }
        if (!ctx?.senderId) {
          const cachedSenderId = getCachedSenderId(ctx);
          if (cachedSenderId) {
            try { ctx.senderId = cachedSenderId; } catch {}
            fileLog(`senderId: restored for before_tool_call sessionId=${ctx?.sessionId || "<none>"} -> ${cachedSenderId}`);
          } else {
            const inferredSenderId = inferSenderIdFromCtx(ctx);
            if (inferredSenderId) {
              try { ctx.senderId = inferredSenderId; } catch {}
              cacheSenderId(ctx, inferredSenderId);
              fileLog(`senderId: inferred for before_tool_call sessionId=${ctx?.sessionId || "<none>"} channelId=${ctx?.channelId || "<none>"} -> ${inferredSenderId}`);
            }
          }
        }
        if (toolAuth && skillNameCandidates.length === 0) {
          const authCtx = buildAuthContext(event, ctx);
          const reason = await preflightAuthDeclaration({
            targetName: event.toolName,
            targetPath: `tool:${event.toolName}`,
            larkAuth: toolAuth,
            ctx: authCtx,
          });
          return reason ? { block: true, reason } : undefined;
        }
        const skillMapEntry = getSkillMapEntry(ctx);
        const abs = directTarget?.abs || resolvePath(rawPath, ctx?.cwd, wsDir);
        let skillName = skillMapEntry.map.get(abs) || directTarget?.skillName || null;
        let skillPath = abs;
        if (!skillName && abs) {
          const fallbackTarget = resolveSkillReadTarget(abs, "/", wsDir);
          if (fallbackTarget?.skillName) {
            skillName = fallbackTarget.skillName;
            skillPath = fallbackTarget.abs;
            fileLog(`fallback: derived skillName="${skillName}" directly from abs path="${abs}"`);
          }
        }
        if (!skillPath && skillNameCandidates.length > 0) {
          for (const candidateName of skillNameCandidates) {
            for (const [candidatePath, candidateSkillName] of skillMapEntry.map.entries()) {
              if (candidateSkillName === candidateName) {
                skillName = candidateName;
                skillPath = candidatePath;
                break;
              }
            }
            if (skillPath) break;
          }
        }
        if (!skillName && skillNameCandidates.length > 0) {
          skillName = skillNameCandidates[0];
        }
        if (!skillName && Array.isArray(ctx?.skillsSnapshot?.resolvedSkills)) {
          const matchedSkill = ctx.skillsSnapshot.resolvedSkills.find((item) => item?.name && item.name === directTarget?.skillName);
          if (matchedSkill?.name) skillName = matchedSkill.name;
        }
        if (!skillName && Array.isArray(event?.skillsSnapshot?.resolvedSkills)) {
          const matchedSkill = event.skillsSnapshot.resolvedSkills.find((item) => item?.name && item.name === directTarget?.skillName);
          if (matchedSkill?.name) skillName = matchedSkill.name;
        }
        if (!skillName) {
          fileLog(`debug: no match for abs="${abs}" rawPath="${rawPath}" skillCandidates=${skillNameCandidates.join(",") || "<none>"} in skillMap (size=${skillMapEntry.map.size}, keys.examples=${[...skillMapEntry.map.keys()].slice(0, 3).join(", ")})`);
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
        const authCtx = buildAuthContext(event, ctx);
        const reason = await preflightSkillAuth({ skillName, skillPath, ctx: authCtx });
        return reason ? { block: true, reason } : undefined;
      } catch (e) {
        fileLog(`hook error: ${e?.message || e}`);
        return;
      }
    }, { priority: 80, timeoutMs: 40000 });
    },
  };
}

export default createPluginEntry();
