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
  checkUserGrant,
  fileLog,
  getAuthedUser,
  getAccountId,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  normalizeAuthIdentity,
  inferSenderIdFromCtx,
  resolveAuthCardRecipient,
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
  checkUserGrant,
  fileLog,
  getAuthedUser,
  getAccountId,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  normalizeAuthIdentity,
  inferSenderIdFromCtx,
  resolveAuthCardRecipient,
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
    checkUserGrant,
    fileLog,
    getAuthedUser,
    getAccountId,
    getCachedSenderId,
    getDefaultSkillRoots,
    getSkillAuthCacheKey,
    normalizeAuthIdentity,
    inferSenderIdFromCtx,
    resolveAuthCardRecipient,
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

  function readMessageText(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(readMessageText).join(" ");
    if (value && typeof value === "object") {
      return readMessageText(value.text ?? value.content ?? value.value ?? "");
    }
    return "";
  }

  // Only inspect actual user messages. OpenClaw's assembled prompt contains every
  // installed Skill name, so using event.prompt here would incorrectly preflight all
  // Skills on every conversation turn.
  function findExplicitSkillNames(event, skillMap) {
    const userText = (Array.isArray(event?.messages) ? event.messages : [])
      .filter((message) => String(message?.role || "").toLowerCase() === "user")
      .map((message) => readMessageText(message?.content ?? message))
      .join("\n");
    if (!userText) return [];
    return [...new Set([...skillMap.values()].filter((skillName) => userText.includes(skillName)))];
  }

  // ---------- 主入口（直接导出 plain entry object，无需 definePluginEntry）----------
  return {
    id: "openclaw-skill-runtime",
    name: "openclaw-skill-runtime",
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
    const pendingAuthRetryLeases = new Map();
    const skillAuthCache = new Map();
    // A missing authorization must block more than the initial SKILL.md read:
    // OpenClaw may invoke the skill's next tool without preserving skill metadata.
    // Keep a session-local gate until the background authorization check succeeds.
    const pendingAuthExecutionGates = new Map();

    function getSessionGateKeys(event, ctx) {
      return [...new Set([
        ctx?.sessionId,
        ctx?.sessionKey,
        event?.sessionId,
        event?.sessionKey,
      ].filter((value) => typeof value === "string" && value.trim()))];
    }

    function openAuthExecutionGate(authTargetKey, skillName, event, ctx, requesterKey = null) {
      for (const sessionKey of getSessionGateKeys(event, ctx)) {
        pendingAuthExecutionGates.set(sessionKey, { authTargetKey, skillName, requesterKey });
      }
    }

    function getAuthExecutionGate(event, ctx) {
      for (const sessionKey of getSessionGateKeys(event, ctx)) {
        const gate = pendingAuthExecutionGates.get(sessionKey);
        if (gate) return gate;
      }
      return null;
    }

    function clearAuthExecutionGates(authTargetKey, requesterKey = null) {
      for (const [sessionKey, gate] of pendingAuthExecutionGates) {
        if (gate.authTargetKey === authTargetKey && (!requesterKey || gate.requesterKey === requesterKey)) {
          pendingAuthExecutionGates.delete(sessionKey);
        }
      }
    }

    function blockForPendingAuthorization(skillName) {
      return {
        block: true,
        reason: `技能「${skillName}」正在等待飞书授权完成，暂不执行后续操作。请完成授权后重试。`,
      };
    }

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

    function markSkillAuthCardSent({ authTargetKey, missingKey, authReason, requesterKey }) {
      if (!authTargetKey || !missingKey) return;
      const previous = skillAuthCache.get(authTargetKey);
      skillAuthCache.set(authTargetKey, {
        missingKey,
        lastSentAtMs: Date.now(),
        authReason,
        requesterKey,
        retryConsumed: previous?.retryConsumed === true,
      });
    }

    function markSkillAuthAuthorized({ authTargetKey, missingKey, authReason, requesterKey }) {
      if (!authTargetKey) return;
      const pendingNotice = pendingAuthNotices.get(authTargetKey);
      if (requesterKey && pendingNotice?.requesterKey && pendingNotice.requesterKey !== requesterKey) return;
      clearAuthExecutionGates(authTargetKey, requesterKey);
      if (authReason !== "user_grant") return;
      skillAuthCache.set(authTargetKey, {
        missingKey,
        lastSentAtMs: Date.now(),
        authorized: true,
        authReason,
        requesterKey,
      });
      if (!pendingNotice || !requesterKey || pendingNotice.requesterKey === requesterKey) clearPendingAuthNotice(authTargetKey);
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
      const activeRetry = pendingAuthRetryLeases.get(authTargetKey);
      if (activeRetry) return await activeRetry;
      const retry = runPendingAuthNoticeRetry(authTargetKey, updates);
      pendingAuthRetryLeases.set(authTargetKey, retry);
      try {
        return await retry;
      } finally {
        if (pendingAuthRetryLeases.get(authTargetKey) === retry) {
          pendingAuthRetryLeases.delete(authTargetKey);
        }
      }
    }

    async function runPendingAuthNoticeRetry(authTargetKey, updates = {}) {
      const current = pendingAuthNotices.get(authTargetKey);
      if (!current) return { ok: false, reason: "missing" };
      const recipientUpdates = {
        ...(updates.openId && updates.openId !== current.openId ? { openId: updates.openId } : {}),
        ...(updates.receiveId && updates.receiveId !== current.receiveId ? { receiveId: updates.receiveId } : {}),
        ...(updates.receiveIdType && updates.receiveIdType !== current.receiveIdType ? { receiveIdType: updates.receiveIdType } : {}),
      };
      const notice = Object.keys(recipientUpdates).length
        ? updatePendingAuthNotice(authTargetKey, recipientUpdates) || current
        : current;
      const receiveId = notice.receiveId || notice.openId;
      const receiveIdType = notice.receiveIdType || (notice.openId ? "open_id" : null);
      if (!receiveId) {
        const failedNotice = recordPendingAuthFailure({
          ...notice,
          lastError: "recipient unresolved",
        });
        return { ok: false, notice: failedNotice, reason: "recipient unresolved" };
      }

      const requiredScopes = notice.requiredScopes || notice.missing;
      let missing = notice.missing;
      let oauthState = notice.oauthState || null;
      if (notice.authReason === "user_grant") {
        const grant = await checkUserGrant(notice.openId, requiredScopes, { accountId: notice.accountId }, { requireScopeDetails: true });
        if (grant?.ok) {
          clearPendingAuthNotice(authTargetKey);
          clearAuthExecutionGates(authTargetKey, notice.requesterKey);
          skillAuthCache.set(authTargetKey, {
            missingKey: requiredScopes.slice().sort().join("|"),
            lastSentAtMs: Date.now(),
            authorized: true,
            authReason: "user_grant",
            requesterKey: notice.requesterKey,
          });
          return { ok: true, authorized: true };
        }
        oauthState = grant?.oauthState || null;
        if (oauthState !== "oauth_reauth_required" && oauthState !== "scope_missing") {
          fileLog(`pendingAuth retry stopped authTargetKey="${authTargetKey}" oauthState=${oauthState || "unknown"} reason=${grant?.reason || "unclassified OAuth result"}`);
          clearPendingAuthNotice(authTargetKey);
          return { ok: false, stopped: true, reason: grant?.reason || "OAuth runtime unavailable" };
        }
        missing = grant?.missing?.length ? grant.missing : requiredScopes;
      }

      const loginScopes = notice.authReason === "user_grant" ? requiredScopes : missing;
      const login = await startLogin(loginScopes, { accountId: notice.accountId }, {
        identity: notice.identity,
        authReason: notice.authReason,
        ...(oauthState ? { oauthState } : {}),
      });
      if (!login?.verificationUrl) {
        const failedNotice = recordPendingAuthFailure({
          ...notice,
          missing,
          oauthState,
          lastError: login?.error || "startLogin failed",
        });
        return { ok: false, notice: failedNotice, reason: login?.error || "startLogin failed" };
      }

      const sent = await sendAuthCard({
        skillName: notice.skillName,
        missing,
        ...login,
        openId: notice.openId,
        receiveId,
        receiveIdType,
        accountId: notice.accountId,
        identity: notice.identity,
        authReason: notice.authReason,
        ...(oauthState ? { oauthState } : {}),
      });
      if (sent.messageId) {
        clearPendingAuthNotice(authTargetKey);
        skillAuthCache.set(authTargetKey, { missingKey: notice.missingKey, lastSentAtMs: Date.now(), requesterKey: notice.requesterKey });
        fileLog(`pendingAuth retry sent "${notice.skillName}" msg=${sent.messageId}`);
        startWaitForAuth({
          authTargetKey,
          skillName: notice.skillName,
          deviceCode: login.deviceCode,
          missingKey: notice.missingKey,
          openId: notice.openId,
          scopes: missing,
          requiredScopes,
          identity: notice.identity,
          authReason: notice.authReason,
          ...(oauthState ? { oauthState } : {}),
          ctx: { accountId: notice.accountId },
          authMessageId: sent.messageId,
          authWaiter: login.authWaiter,
          onAuthorized: (details) => markSkillAuthAuthorized({ ...details, requesterKey: notice.requesterKey }),
          onAuthCardSent: (details) => markSkillAuthCardSent({ ...details, requesterKey: notice.requesterKey }),
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

      // A Skill may already be described in the model prompt, in which case the
      // model can answer without reading SKILL.md or making a tool call.  Preflight
      // only when the user explicitly names a registered Skill, and reuse the exact
      // same guarded read path used for normal runtime execution.
      if (ctx?.messageProvider === "feishu" || ctx?.channel === "feishu") {
        const skillMapEntry = getSkillMapEntry(ctx);
        const explicitSkillNames = findExplicitSkillNames(event, skillMapEntry.map);
        for (const skillName of explicitSkillNames) {
          const skillPath = [...skillMapEntry.map.entries()]
            .find(([, candidateSkillName]) => candidateSkillName === skillName)?.[0];
          if (!skillPath) continue;
          fileLog(`before_prompt_build explicit skill preflight skill="${skillName}"`);
          const result = await guardToolCall({
            toolName: "read",
            params: { path: skillPath },
          }, {
            ...ctx,
            skillCommand: { skillName },
          });
          if (result?.block) return result;
        }
      }
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
    });

    async function guardToolCall(event, ctx) {
      let guardedSkillName = null;
      try {
        logCtxSnapshotOnce(ctx);
        fileLog(`hook: tool=${event?.toolName || ""} channel=${ctx?.channel || ""} path=${event?.params?.path || ""}`);
        fileLog(`before_tool_call summary=${safeJson(buildHookDebugSummary(event, ctx))}`);
        if (ctx && ctx.channel && ctx.channel !== "feishu") return;
        const rawPath = event.params?.path;
        const wsDir = resolveWorkspaceDir(ctx);
        const directTarget = resolveSkillReadTarget(rawPath, ctx?.cwd, wsDir);
        const skillNameCandidates = collectSkillNameCandidates(event, ctx, directTarget);
        const isReadTool = event.toolName === "read";
        const pendingGate = getAuthExecutionGate(event, ctx);
        if (pendingGate && !skillNameCandidates.includes(pendingGate.skillName)) {
          fileLog(`auth gate blocked tool=${event?.toolName || ""} skill="${pendingGate.skillName}"`);
          return blockRead ? blockForPendingAuthorization(pendingGate.skillName) : undefined;
        }
        if (!isReadTool && skillNameCandidates.length === 0) return;
        if (isReadTool) {
          fileLog(`hook: read-enter rawPath=${event?.params?.path || ""} cwd=${ctx?.cwd || ""}`);
        } else {
          fileLog(`hook: skill-runtime-enter tool=${event?.toolName || ""} skillCandidates=${skillNameCandidates.join(",") || "<none>"}`);
        }
        if (!rawPath && skillNameCandidates.length === 0) return;
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
        const larkAuth = readLarkAuth(skillPath);
        if (!larkAuth || !larkAuth.scopes.length) return;
        guardedSkillName = skillName;
        const identity = normalizeAuthIdentity(larkAuth.identity);
        let resolvedUser = identity === "user" ? await getAuthedUser(ctx).catch(() => null) : null;
        const requesterKey = identity === "user"
          ? (resolvedUser?.openId || getCachedSenderId(ctx) || getSessionGateKeys(event, ctx)[0] || null)
          : null;
        const authTargetKey = getSkillAuthCacheKey(skillPath, ctx);

        const runtime = await ensureFeishuRuntimeHealth();
        if (!runtime.ok) {
          const reason = `技能「${skillName}」依赖的飞书运行时当前不可用，无法完成权限校验。${runtime.recoveryHint || "请补齐 Feishu 应用凭据后重试。"}`;
          fileLog(`runtime blocked skill="${skillName}" reason=${reason}`);
          return blockRead ? { block: true, reason } : undefined;
        }

        const appScopeCheck = await checkScopes(larkAuth.scopes, ctx, { identity });
        let authReason = "app_scope";
        let missing = appScopeCheck.missing?.length ? appScopeCheck.missing : [];
        let userGrantCheck = null;

        if (appScopeCheck.ok && identity === "app") {
          clearPendingAuthNotice(authTargetKey);
          skillAuthCache.delete(authTargetKey);
          clearAuthExecutionGates(authTargetKey);
          return;
        }

        if (appScopeCheck.ok && identity === "user") {
          const fullMissingKey = larkAuth.scopes.slice().sort().join("|");
          fileLog(`skill="${skillName}" app scopes are open; checking user grant with scope details`);
          userGrantCheck = await checkUserGrant(resolvedUser?.openId, larkAuth.scopes, ctx, { requireScopeDetails: true });
          if (userGrantCheck.ok) {
            clearPendingAuthNotice(authTargetKey);
            clearAuthExecutionGates(authTargetKey);
            skillAuthCache.set(authTargetKey, {
              missingKey: fullMissingKey,
              lastSentAtMs: Date.now(),
              authorized: true,
              authReason: "user_grant",
            });
            fileLog(`skill="${skillName}" user grant already authorized with scope details`);
            return;
          }
          if (userGrantCheck.oauthState === "oauth_runtime_unavailable") {
            // A persisted retry cannot make progress while the authoritative OAuth
            // verifier is unavailable (including app/user identity mismatches).
            // Drop it rather than later replaying an obsolete Device Flow card.
            clearPendingAuthNotice(authTargetKey);
            const reason = `技能「${skillName}」的飞书用户授权运行时当前不可用，无法发起授权。${userGrantCheck.reason || "请检查 OAuth 运行时后重试。"}`;
            fileLog(`user grant runtime unavailable skill="${skillName}" reason=${userGrantCheck.reason || "unknown"}`);
            return blockRead ? { block: true, reason } : undefined;
          }
          authReason = "user_grant";
          missing = userGrantCheck.missing?.length ? userGrantCheck.missing : larkAuth.scopes;
          fileLog(`skill="${skillName}" user grant missing or unverifiable: ${missing.join(", ")} reason=${userGrantCheck.reason || "not granted"}`);
        } else {
          missing = missing.length ? missing : larkAuth.scopes;
          fileLog(`skill="${skillName}" app ${identity} scopes missing: ${missing.join(", ")}`);
        }

        api.log?.info?.(`[openclaw-skill-runtime] skill="${skillName}" identity=${identity} authReason=${authReason} missing: ${missing.join(", ")}`);
        openAuthExecutionGate(authTargetKey, skillName, event, ctx, requesterKey);
        const now = Date.now();
        const resolvedAccountId = getAccountId(ctx);
        const pendingNotice = pendingAuthNotices.get(authTargetKey);
        if (pendingNotice) {
          if (identity === "user" && (!requesterKey || pendingNotice.requesterKey !== requesterKey)) {
            fileLog(`pendingAuth discarded cross-user notice authTargetKey="${authTargetKey}"`);
            clearPendingAuthNotice(authTargetKey);
          } else if (pendingNotice.status === "exhausted") {
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
            const recipient = resolveAuthCardRecipient(ctx);
            const retried = await retryPendingAuthNotice(authTargetKey, {
              openId: resolvedUser?.openId,
              receiveId: recipient?.receiveId || null,
              receiveIdType: recipient?.receiveIdType || null,
            });
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
        const missingKey = (authReason === "user_grant" ? larkAuth.scopes : missing).slice().sort().join("|");
        if (cache) {
          fileLog(`debug: authTargetKey="${authTargetKey}" cache.missingKey="${cache.missingKey}" cur.missingKey="${missingKey}" age=${Math.round((now - cache.lastSentAtMs) / 1000)}s`);
        }
        if (cache && cache.requesterKey === requesterKey && cache.missingKey === missingKey && (now - cache.lastSentAtMs) < 180000) {
          if (!cache.retryConsumed) {
            skillAuthCache.set(authTargetKey, { ...cache, retryConsumed: true });
            fileLog(`retry: authTargetKey="${authTargetKey}" explicit retry allowed during cooldown`);
          } else {
            fileLog(`skip: authTargetKey="${authTargetKey}" cooldown active (${Math.round((now - cache.lastSentAtMs) / 1000)}s ago)`);
            return blockRead ? { block: true, reason: `技能「${skillName}」需要飞书权限授权，上次已发送授权卡片，请完成授权后重试。` } : undefined;
          }
        }

        let loginError = null;
        const oauthState = authReason === "user_grant" ? userGrantCheck?.oauthState || null : null;
        const loginScopes = authReason === "user_grant" ? larkAuth.scopes : missing;
        const login = await startLogin(loginScopes, ctx, { identity, authReason, oauthState });
        if (login.verificationUrl) {
          const user = resolvedUser || await getAuthedUser(ctx);
          const recipient = resolveAuthCardRecipient(ctx);
          const sent = await sendAuthCard({
            skillName,
            missing,
            ...login,
            openId: user?.openId,
            receiveId: recipient?.receiveId || null,
            receiveIdType: recipient?.receiveIdType || null,
            accountId: resolvedAccountId,
            identity,
            authReason,
            ...(oauthState ? { oauthState } : {}),
          });
          if (sent.messageId) {
            clearPendingAuthNotice(authTargetKey);
            skillAuthCache.set(authTargetKey, {
              missingKey,
              lastSentAtMs: now,
              requesterKey,
              retryConsumed: skillAuthCache.get(authTargetKey)?.retryConsumed === true,
            });
            const mode = blockRead ? "(blocked)" : "";
            fileLog(`auth card ${mode} "${skillName}" sent msg=${sent.messageId}`);
            startWaitForAuth({ authTargetKey, skillName, deviceCode: login.deviceCode, missingKey, openId: user?.openId, scopes: missing, requiredScopes: larkAuth.scopes, identity, authReason, ...(oauthState ? { oauthState } : {}), ctx, authMessageId: sent.messageId, authWaiter: login.authWaiter, onAuthorized: (details) => markSkillAuthAuthorized({ ...details, requesterKey }), onAuthCardSent: (details) => markSkillAuthCardSent({ ...details, requesterKey }) });
          } else {
            fileLog(`sendAuthCard failed: ${sent.error}`);
            const notice = recordPendingAuthFailure({
              authTargetKey,
              skillName,
              skillPath,
              accountId: resolvedAccountId,
              openId: user?.openId || null,
              receiveId: recipient?.receiveId || user?.openId || null,
              receiveIdType: recipient?.receiveIdType || (user?.openId ? "open_id" : null),
              missing,
              requiredScopes: larkAuth.scopes,
              missingKey,
              identity,
              authReason,
              requesterKey,
              ...(oauthState ? { oauthState } : {}),
              lastError: sent.error || "send failed",
            });
            if (notice?.status === "retrying") schedulePendingAuthRetry(authTargetKey);
          }
        } else {
          loginError = login?.error || "startLogin failed";
          fileLog(`startLogin failed "${skillName}": ${loginError}`);
        }
        // 无论发卡是否成功，只要 blockRead=true 且 scopes 缺失，一律拦截 read，
        // 防止模型拿到 SKILL.md 内容后绕过授权直接执行 skill。
        if (blockRead) {
          if (loginError) {
            return {
              block: true,
              reason: `Skill "${skillName}" requires Feishu authorization, but the authorization runtime is not ready: ${loginError}`,
            };
          }
          const reason = pendingAuthNotices.has(authTargetKey)
            ? `技能「${skillName}」需要飞书权限授权，授权提醒发送失败，系统会自动重试，请稍后重试。`
            : `技能「${skillName}」需要飞书权限授权，已发送授权卡片，请先完成授权后重试。`;
          return { block: true, reason };
        }
        return;
      } catch (e) {
        fileLog(`hook error: ${e?.message || e}`);
        if (blockRead && guardedSkillName) {
          return {
            block: true,
            reason: `技能「${guardedSkillName}」的飞书授权校验异常，为避免未授权执行，已阻断本次操作，请稍后重试。`,
          };
        }
        return;
      }
    }
    api.on("before_tool_call", guardToolCall, { priority: 80, timeoutMs: 40000 });
    },
  };
}

export default createPluginEntry();
