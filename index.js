import { join } from "node:path";

import { readLarkAuth } from "./parse-meta.js";
import { collectSkillAuthManifest } from "./skill-auth-manifest.js";
import {
  PENDING_AUTH_MAX_RETRIES,
  bumpPendingAuthNoticeFailure,
  canRetryPendingAuthNotice,
  createPendingAuthNotice,
  getAuthCardRecordStorePath,
  getPendingAuthNoticeStorePath,
  markPendingAuthNoticeExhausted,
  readAuthCardRecordStore,
  readPendingAuthNoticeStore,
  removeAuthCardRecord,
  upsertAuthCardRecord,
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
  filterScopesNeedingUserGrant,
  fileLog,
  getAppScopeEntries,
  getAuthPollingSnapshot,
  expandLarkAuthWithManagedSkills,
  getAuthedUser,
  getAccountId,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  normalizeAuthIdentity,
  inferSenderIdFromCtx,
  cacheTrustedSenderFromHook,
  summarizeSenderIdentityForLog,
  augmentCtxWithFeishuAccount,
  augmentHookRoutingContext,
  isAuthPollingActive,
  isAuthPollingActiveForTarget,
  resolveAuthCardRecipient,
  resolveInstallAuthRecipient,
  ensureFeishuRuntimeHealth,
  finalizeAuthStageCard,
  PLUGIN_RUNTIME_BUILD,
  logCtxSnapshotOnce,
  resolvePath,
  resolveSkillReadTarget,
  selectExplicitSkillNames,
  resolveWorkspaceDir,
  resetRuntimeCaches,
  sendAuthCard,
  setApiConfigRef,
  setPluginApiRef,
  startLogin,
  startWaitForAuth,
  cacheAccountIdFromEventAndCtx,
  syncLarkCliProfiles,
  setPluginConfigRef,
} from "./utils.js";

const baseDeps = {
  readLarkAuth,
  collectSkillAuthManifest,
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
  filterScopesNeedingUserGrant,
  fileLog,
  getAppScopeEntries,
  getAuthPollingSnapshot,
  expandLarkAuthWithManagedSkills,
  getAuthedUser,
  getAccountId,
  getCachedSenderId,
  getDefaultSkillRoots,
  getSkillAuthCacheKey,
  normalizeAuthIdentity,
  inferSenderIdFromCtx,
  cacheTrustedSenderFromHook,
  summarizeSenderIdentityForLog,
  augmentCtxWithFeishuAccount,
  augmentHookRoutingContext,
  isAuthPollingActive,
  isAuthPollingActiveForTarget,
  resolveAuthCardRecipient,
  resolveInstallAuthRecipient,
  ensureFeishuRuntimeHealth,
  finalizeAuthStageCard,
  PLUGIN_RUNTIME_BUILD,
  logCtxSnapshotOnce,
  resolvePath,
  resolveSkillReadTarget,
  selectExplicitSkillNames,
  resolveWorkspaceDir,
  resetRuntimeCaches,
  sendAuthCard,
  setApiConfigRef,
  setPluginApiRef,
  startLogin,
  startWaitForAuth,
  setPluginConfigRef,
};

export function createPluginEntry(overrides = {}) {
  const deps = { ...baseDeps, ...overrides };
  const sharedPendingAuthRuntimeByStorePath = new Map();
  const {
    readLarkAuth,
    collectSkillAuthManifest,
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
    filterScopesNeedingUserGrant,
    fileLog,
    getAppScopeEntries,
    getAuthedUser,
    getAccountId,
    getCachedSenderId,
    expandLarkAuthWithManagedSkills,
    getDefaultSkillRoots,
    getSkillAuthCacheKey,
    normalizeAuthIdentity,
    inferSenderIdFromCtx,
    isAuthPollingActive,
    isAuthPollingActiveForTarget,
    resolveAuthCardRecipient,
    resolveInstallAuthRecipient,
    ensureFeishuRuntimeHealth,
    logCtxSnapshotOnce,
    resolvePath,
    resolveSkillReadTarget,
    selectExplicitSkillNames,
    resolveWorkspaceDir,
    resetRuntimeCaches,
    sendAuthCard,
    setApiConfigRef,
    setPluginApiRef,
    startLogin,
    startWaitForAuth,
    setPluginConfigRef,
  } = deps;
  const installAuthRunKeys = new Set();

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
      eventAccountId: event?.accountId || event?.account || null,
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
      senderIdentity: summarizeSenderIdentityForLog(event, ctx),
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

  const latestUserTextBySession = new Map();

  function readMessageText(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(readMessageText).join(" ");
    if (value && typeof value === "object") {
      return readMessageText(value.text ?? value.content ?? value.value ?? "");
    }
    return "";
  }

  function sessionTextKeys(event, ctx) {
    return [...new Set([
      ctx?.sessionId,
      ctx?.sessionKey,
      event?.sessionId,
      event?.sessionKey,
    ].filter((value) => typeof value === "string" && value.trim()))];
  }

  function readInboundUserText(event) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => String(message?.role || "").toLowerCase() === "user");
    const fromMessages = latestUserMessage
      ? readMessageText(latestUserMessage?.content ?? latestUserMessage)
      : "";
    if (fromMessages.trim()) return fromMessages.trim();
    for (const value of [event?.body, event?.text, event?.content, event?.message, event?.rawBody]) {
      const text = readMessageText(value);
      if (text.trim() && text.trim().length <= 4000) return text.trim();
    }
    return "";
  }

  function rememberLatestUserText(event, ctx) {
    const text = readInboundUserText(event);
    if (!text) return;
    for (const key of sessionTextKeys(event, ctx)) latestUserTextBySession.set(key, text);
  }

  // Only inspect actual user messages. OpenClaw's assembled prompt contains every
  // installed Skill name, and event.messages may contain conversation history, so
  // only the latest user message should trigger explicit skill preflight.
  function findExplicitSkillNames(event, skillMap, ctx) {
    let userText = readInboundUserText(event);
    if (!userText) {
      for (const key of sessionTextKeys(event, ctx)) {
        const cached = latestUserTextBySession.get(key);
        if (cached) {
          userText = cached;
          break;
        }
      }
    }
    if (!userText) return [];
    return selectExplicitSkillNames(userText, skillMap);
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
    const activeApiConfig = incomingHasAccounts ? incoming : apiConfigRef;
    // 插件私有配置在 api.pluginConfig（不是 api.config）
    const cfg = api.pluginConfig || {};
    setPluginConfigRef(cfg);
    setPluginApiRef(api);
    const availableTools = Object.keys(api.tools || {}).sort();
    const authDebugTools = availableTools.filter((name) =>
      /check_user_grant|feishu|lark/i.test(name),
    );
    fileLog(`register: availableTools=${availableTools.length} authDebugTools=${authDebugTools.join(",") || "<none>"}`);
    resetRuntimeCaches();
    if (cfg.enabled === false) { fileLog("disabled by config"); return; }
    const blockRead = cfg.blockRead !== false;
    try {
      syncLarkCliProfiles(apiConfigRef);
    } catch (e) {
      fileLog(`syncLarkCliProfiles error: ${e?.message || e}`);
    }
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

    function normalizeInstallAuthConfig(ctx = null) {
      const installAuth = cfg.installAuth && typeof cfg.installAuth === "object"
        ? cfg.installAuth
        : {};
      if (installAuth.enabled === false) return null;
      const explicitReceiveId = typeof installAuth.receiveId === "string" && installAuth.receiveId.trim()
        ? installAuth.receiveId.trim()
        : typeof installAuth.openId === "string" && installAuth.openId.trim()
          ? installAuth.openId.trim()
          : null;
      const explicitReceiveIdType = typeof installAuth.receiveIdType === "string" && installAuth.receiveIdType.trim()
        ? installAuth.receiveIdType.trim()
        : "open_id";
      const ctxRecipient = !explicitReceiveId && ctx ? resolveAuthCardRecipient(ctx) : null;
      const receiveId = explicitReceiveId || (
        ctxRecipient?.receiveIdType === "open_id" ? ctxRecipient.receiveId : null
      );
      const receiveIdType = explicitReceiveId ? explicitReceiveIdType : "open_id";
      const openId = typeof installAuth.openId === "string" && installAuth.openId.trim()
        ? installAuth.openId.trim()
        : receiveIdType === "open_id"
          ? receiveId
          : null;
      if (receiveId && receiveIdType !== "open_id") {
        fileLog("installAuth skipped: automatic install authorization requires receiveIdType=open_id");
        return null;
      }
      if (receiveId && openId && receiveId !== openId) {
        fileLog("installAuth skipped: receiveId/openId conflict");
        return null;
      }
      const profile = typeof installAuth.profile === "string" && installAuth.profile.trim()
        ? installAuth.profile.trim()
        : null;
      return {
        receiveId,
        receiveIdType,
        openId,
        profile,
        source: explicitReceiveId ? "config" : ctxRecipient?.receiveIdType === "open_id" ? "hook-sender" : "auto",
      };
    }

    function getInstallAuthSkillRoots() {
      const roots = Array.isArray(cfg.skillRoots) && cfg.skillRoots.length
        ? cfg.skillRoots
        : getDefaultSkillRoots(null);
      const configAgents = Array.isArray(activeApiConfig?.agents?.list)
        ? activeApiConfig.agents.list
        : [];
      const agentRoots = configAgents
        .map((agent) => {
          if (!agent?.workspace || !agent?.id) return null;
          return {
            root: join(String(agent.workspace), "skills"),
            agentId: String(agent.id),
          };
        })
        .filter(Boolean);
      return [...roots, ...agentRoots];
    }

    function uniqueSortedScopes(values) {
      return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
    }

    function buildManifestAppAuth(app) {
      const appScopes = uniqueSortedScopes(app?.installScopes?.app);
      const userScopes = uniqueSortedScopes(app?.installScopes?.user);
      const unknownScopes = uniqueSortedScopes(app?.installScopes?.unknown);
      const personalOAuthScopes = uniqueSortedScopes(app?.personalOAuthScopes);
      const scopes = uniqueSortedScopes([...appScopes, ...userScopes, ...unknownScopes, ...personalOAuthScopes]);
      if (!scopes.length) return null;

      const scopeInstallGrant = {};
      const scopeInstallGrants = {};
      for (const scope of scopes) {
        const grants = [];
        if (appScopes.includes(scope)) grants.push("app");
        if (userScopes.includes(scope)) grants.push("user");
        if (grants.length === 1) scopeInstallGrant[scope] = grants[0];
        if (grants.length > 1) scopeInstallGrants[scope] = grants;
      }
      const identity = userScopes.length || unknownScopes.length || personalOAuthScopes.length ? "user" : "app";
      const auth = {
        identity,
        scopes,
        scopeInstallGrant,
      };
      if (Object.keys(scopeInstallGrants).length) auth.scopeInstallGrants = scopeInstallGrants;
      return auth;
    }

    const pendingAuthStorePath = getPendingAuthNoticeStorePath();
    const authCardRecordStorePath = getAuthCardRecordStorePath();
    fileLog(`register: pluginId=openclaw-skill-runtime build=${PLUGIN_RUNTIME_BUILD} apiConfig=${apiConfigRef ? "present" : "null"} feishuAccounts=${apiConfigRef?.channels?.feishu?.accounts ? Object.keys(apiConfigRef.channels.feishu.accounts).join(",") : "<none>"} incomingHadAccounts=${incomingHasAccounts} enabled=${cfg.enabled !== false} blockRead=${cfg.blockRead !== false} skillRoots=${Array.isArray(cfg.skillRoots) ? cfg.skillRoots.length : 0} pendingAuthStorePath=${pendingAuthStorePath}`);
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
    const AUTH_EXECUTION_GATE_WAIT_MS = 180000;

    function getSessionGateKeys(event, ctx) {
      return [...new Set([
        ctx?.sessionId,
        ctx?.sessionKey,
        event?.sessionId,
        event?.sessionKey,
      ].filter((value) => typeof value === "string" && value.trim()))];
    }

    function openAuthExecutionGate(authTargetKey, skillName, event, ctx, requesterKey = null) {
      const waitUntilMs = Date.now() + AUTH_EXECUTION_GATE_WAIT_MS;
      for (const sessionKey of getSessionGateKeys(event, ctx)) {
        pendingAuthExecutionGates.set(sessionKey, {
          authTargetKey,
          skillName,
          requesterKey,
          waitUntilMs,
        });
      }
    }

    function refreshAuthExecutionGateWait(authTargetKey, waitMs = AUTH_EXECUTION_GATE_WAIT_MS) {
      const normalizedWaitMs = Math.min(
        Math.max(Number(waitMs) || AUTH_EXECUTION_GATE_WAIT_MS, 1000),
        AUTH_EXECUTION_GATE_WAIT_MS,
      );
      const waitUntilMs = Date.now() + normalizedWaitMs;
      for (const gate of pendingAuthExecutionGates.values()) {
        if (gate.authTargetKey === authTargetKey) gate.waitUntilMs = waitUntilMs;
      }
    }

    function describeAuthGateWait(pendingGate) {
      const waitUntilMs = Number(pendingGate?.waitUntilMs || 0);
      const waitRemainingMs = waitUntilMs > 0 ? Math.max(0, waitUntilMs - Date.now()) : 0;
      return { waitUntilMs, waitRemainingMs };
    }

    function isAuthPollingStale(pendingGate) {
      const snapshot =
        getAuthPollingSnapshot(pendingGate?.authTargetKey) ||
        (pendingGate?.skillName ? getAuthPollingSnapshot(pendingGate.skillName) : null);
      if (!snapshot?.active) return true;
      if (!snapshot.hasInterval) return true;
      const lastPollAgeMs = snapshot.lastPollAtMs > 0 ? Date.now() - snapshot.lastPollAtMs : Number.POSITIVE_INFINITY;
      const startedAgeMs = snapshot.startedAtMs > 0 ? Date.now() - snapshot.startedAtMs : 0;
      if (startedAgeMs > AUTH_EXECUTION_GATE_WAIT_MS + 15000) return true;
      if (lastPollAgeMs > 45000) return true;
      return false;
    }

    function releaseStaleAuthExecutionGate(pendingGate) {
      if (!pendingGate?.authTargetKey) {
        if (pendingGate?.skillName) {
          fileLog(`auth gate stale release skill="${pendingGate.skillName}" reason=missing-authTargetKey`);
          for (const [sessionKey, gate] of pendingAuthExecutionGates) {
            if (gate.skillName === pendingGate.skillName) pendingAuthExecutionGates.delete(sessionKey);
          }
          return true;
        }
        return false;
      }
      if (pendingGate.rejected === true) return false;
      const pollingActive = isAuthPollingActiveForTarget(pendingGate);
      const { waitUntilMs, waitRemainingMs } = describeAuthGateWait(pendingGate);
      const waitExpired = waitUntilMs === 0 || Date.now() > waitUntilMs;
      const pollingStale = pollingActive && isAuthPollingStale(pendingGate);
      if (!pollingActive || waitExpired || pollingStale) {
        fileLog(
          `auth gate stale release authTargetKey="${pendingGate.authTargetKey}" skill="${pendingGate.skillName}" pollingActive=${pollingActive} pollingStale=${pollingStale} waitExpired=${waitExpired} waitRemainingMs=${waitRemainingMs}`,
        );
        clearAuthExecutionGates(pendingGate.authTargetKey);
        return true;
      }
      return false;
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

    function markAuthExecutionGateRejected(authTargetKey) {
      for (const gate of pendingAuthExecutionGates.values()) {
        if (gate.authTargetKey === authTargetKey) gate.rejected = true;
      }
    }

    function blockForPendingAuthorization(skillName, pendingGate = null) {
      if (pendingGate?.rejected) {
        return {
          block: true,
          reason: `技能「${skillName}」的飞书授权已拒绝，当前会话中的技能已全部停止。如需继续，请重新触发该技能。`,
        };
      }
      return {
        block: true,
        reason: `技能「${skillName}」正在等待飞书授权完成，暂不执行后续操作。请完成授权后重试。`,
      };
    }

    function isFeishuLarkToolName(toolName) {
      return /(^|[_:.-])(feishu|lark)([_:.-]|$)/i.test(String(toolName || ""));
    }

    function getToolCommandText(event) {
      const params = event?.params || {};
      const value = params.command ?? params.cmd ?? params.script ?? event?.command;
      if (Array.isArray(value)) return value.join(" ");
      return typeof value === "string" ? value : "";
    }

    function isLarkCliCommand(event) {
      const command = getToolCommandText(event);
      return /(^|[\s"'`;&|()\\/])(?:lark-cli(?:\.(?:cmd|exe))?|feishu-lark-cli)(?=$|[\s"'`;&|()\\/])/i.test(command);
    }

    function isProtectedPendingAuthOperation(event, pendingGate, directTarget, skillNameCandidates) {
      const pendingSkillName = normalizeSkillName(pendingGate?.skillName);
      if (!pendingSkillName) return false;
      if (normalizeSkillName(directTarget?.skillName) === pendingSkillName) return true;
      if (skillNameCandidates.includes(pendingSkillName)) return true;
      if (isFeishuLarkToolName(event?.toolName)) return true;
      if (isLarkCliCommand(event)) return true;
      return false;
    }

    function hasExplicitRetryIntent(ctx, skillName) {
      return ctx?.authIntent?.type === "explicit_skill_retry"
        && normalizeSkillName(ctx.authIntent.skillName) === normalizeSkillName(skillName);
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

    function rememberAuthCardPollSession(input = {}) {
      const authTargetKey = input.authTargetKey;
      const messageId = input.messageId;
      const skillName = input.skillName;
      if (!authTargetKey || !messageId || !skillName) return;
      upsertAuthCardRecord(authCardRecordStorePath, {
        authTargetKey,
        authMessageId: messageId,
        skillName,
        accountId: input.accountId,
        authReason: input.authReason,
        requesterKey: input.requesterKey,
        deviceCode: input.deviceCode,
        missingKey: input.missingKey,
        missing: input.missing,
        requiredScopes: input.requiredScopes,
        scopeInstallGrant: input.scopeInstallGrant,
        identity: input.identity,
        openId: input.openId,
        larkProfile: input.larkProfile,
      });
    }

    function resumeOutstandingAuthPolls() {
      const records = readAuthCardRecordStore(authCardRecordStorePath);
      for (const record of records.values()) {
        if (record.cardFinalized || !record.deviceCode) continue;
        if (Date.now() - Number(record.updatedAt || 0) > AUTH_EXECUTION_GATE_WAIT_MS + 60000) continue;
        if (isAuthPollingActiveForTarget(record)) continue;
        fileLog(
          `resumeAuthPoll: skill="${record.skillName}" msg=${record.authMessageId} authReason=${record.authReason || "app_scope"}`,
        );
        startWaitForAuth({
          authTargetKey: record.authTargetKey,
          skillName: record.skillName,
          deviceCode: record.deviceCode,
          missingKey: record.missingKey || record.missing?.slice().sort().join("|"),
          openId: record.openId,
          scopes: record.missing,
          requiredScopes: record.requiredScopes?.length ? record.requiredScopes : record.missing,
          scopeInstallGrant: record.scopeInstallGrant || null,
          identity: record.identity || "user",
          authReason: record.authReason || "app_scope",
          larkProfile: record.larkProfile || null,
          ctx: {
            accountId: record.accountId,
            account: record.accountId,
          },
          authMessageId: record.authMessageId,
          ...buildSkillAuthWaitCallbacks(record.authTargetKey, record.requesterKey),
        });
      }
    }

    function resolveAuthCardTracking(authTargetKey) {
      const memory = skillAuthCache.get(authTargetKey) || {};
      const stored = readAuthCardRecordStore(authCardRecordStorePath).get(authTargetKey);
      if (!stored) return memory;
      return {
        ...stored,
        ...memory,
        authMessageId: memory.authMessageId || stored.authMessageId,
        skillName: memory.skillName || stored.skillName,
        cardFinalized: memory.cardFinalized === true || stored.cardFinalized === true,
      };
    }

    function markSkillAuthCardSent({
      authTargetKey,
      missingKey,
      authReason,
      requesterKey,
      messageId,
      skillName,
      ctx,
      deviceCode,
      scopes,
      requiredScopes,
      identity,
      openId,
      larkProfile,
    }) {
      if (!authTargetKey || !missingKey) return;
      const previous = skillAuthCache.get(authTargetKey);
      skillAuthCache.set(authTargetKey, {
        missingKey,
        lastSentAtMs: Date.now(),
        authReason,
        requesterKey,
        retryConsumed: previous?.retryConsumed === true,
        ...(previous?.authMessageId && !messageId ? { authMessageId: previous.authMessageId } : {}),
        ...(messageId ? { authMessageId: messageId } : {}),
      });
      if (messageId && skillName) {
        rememberAuthCardPollSession({
          authTargetKey,
          skillName,
          messageId,
          accountId: getAccountId(ctx) || ctx?.accountId || ctx?.account || null,
          authReason,
          requesterKey,
          deviceCode,
          missingKey,
          missing: scopes,
          requiredScopes,
          identity,
          openId,
          larkProfile,
        });
      }
    }

    async function reconcileOutstandingAuthCard({
      authTargetKey,
      skillName,
      accountId,
      userGrantComplete = false,
      authReason = "app_scope",
    }) {
      const cache = resolveAuthCardTracking(authTargetKey);
      const resolvedSkillName = skillName || cache.skillName;
      const resolvedAccountId = accountId || cache.accountId || null;
      if (!cache?.authMessageId || cache.cardFinalized === true || !resolvedSkillName) return;
      try {
        const result = await finalizeAuthStageCard({
          messageId: cache.authMessageId,
          skillName: resolvedSkillName,
          authReason: userGrantComplete ? "app_scope" : (cache.authReason || authReason),
          accountId: resolvedAccountId,
          userGrantComplete,
        });
        if (result?.messageId) {
          skillAuthCache.set(authTargetKey, {
            ...cache,
            cardFinalized: true,
            authorized: true,
            userGrantComplete,
          });
          removeAuthCardRecord(authCardRecordStorePath, authTargetKey);
          fileLog(
            `reconcileAuthCard: finalized msg=${cache.authMessageId} skill="${resolvedSkillName}" userGrantComplete=${userGrantComplete}`,
          );
        }
      } catch (error) {
        fileLog(`reconcileAuthCard: failed skill="${resolvedSkillName}" msg=${cache.authMessageId}: ${error?.message || error}`);
      }
    }

    async function markSkillAuthAuthorized({ authTargetKey, missingKey, authReason, requesterKey, skillName, ctx }) {
      if (!authTargetKey) return;
      const pendingNotice = pendingAuthNotices.get(authTargetKey);
      if (requesterKey && pendingNotice?.requesterKey && pendingNotice.requesterKey !== requesterKey) return;
      clearAuthExecutionGates(authTargetKey, requesterKey);
      const previous = skillAuthCache.get(authTargetKey);
      const accountId = getAccountId(ctx) || ctx?.accountId || ctx?.account || null;
      if (skillName && previous?.authMessageId && previous.cardFinalized !== true) {
        await reconcileOutstandingAuthCard({
          authTargetKey,
          skillName,
          accountId,
          userGrantComplete: authReason === "user_grant",
          authReason: authReason === "user_grant" ? "user_grant" : "app_scope",
        });
      }
      if (authReason !== "user_grant") return;
      skillAuthCache.set(authTargetKey, {
        missingKey,
        lastSentAtMs: Date.now(),
        authorized: true,
        authReason,
        requesterKey,
        authMessageId: previous?.authMessageId,
        cardFinalized: true,
      });
      if (!pendingNotice || !requesterKey || pendingNotice.requesterKey === requesterKey) clearPendingAuthNotice(authTargetKey);
    }

    function buildSkillAuthWaitCallbacks(authTargetKey, requesterKey) {
      return {
        onAuthorized: (details) => { void markSkillAuthAuthorized({ ...details, requesterKey }); },
        onAuthCardSent: (details) => markSkillAuthCardSent({ ...details, requesterKey }),
        onPollAttached: () => refreshAuthExecutionGateWait(authTargetKey),
        onCleanup: ({ reason } = {}) => {
          if (reason === "handoff") return;
          if (reason === "denied") {
            markAuthExecutionGateRejected(authTargetKey);
            fileLog(
              `waitForAuth onCleanup held rejected auth gate authTargetKey="${authTargetKey}" requesterKey=${requesterKey || "<none>"}`,
            );
            return;
          }
          clearAuthExecutionGates(authTargetKey);
          fileLog(
            `waitForAuth onCleanup released auth gate authTargetKey="${authTargetKey}" reason=${reason || "unknown"} requesterKey=${requesterKey || "<none>"}`,
          );
        },
      };
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

      const larkAuthFromSkill = notice.skillPath ? readLarkAuth(notice.skillPath) : null;
      const expandedAuth = expandLarkAuthWithManagedSkills(larkAuthFromSkill, {
        skillPath: notice.skillPath,
      });
      const scopeInstallGrant = expandedAuth.auth?.scopeInstallGrant || larkAuthFromSkill?.scopeInstallGrant || null;
      const scopeInstallGrants = expandedAuth.auth?.scopeInstallGrants || larkAuthFromSkill?.scopeInstallGrants || null;
      const requiredScopes = expandedAuth.auth?.scopes?.length
        ? expandedAuth.auth.scopes
        : (notice.requiredScopes || notice.missing);
      let missing = notice.missing;
      let oauthState = notice.oauthState || null;
      const appScopeEntries = await getAppScopeEntries({ accountId: notice.accountId }).catch(() => null);
      const userGrantScopes = filterScopesNeedingUserGrant(requiredScopes, appScopeEntries, {
        scopeInstallGrant,
        scopeInstallGrants,
      });
      if (notice.authReason === "user_grant") {
        const grant = await checkUserGrant(
          notice.openId,
          userGrantScopes,
          { accountId: notice.accountId },
          { requireScopeDetails: true },
        );
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
        missing = grant?.missing?.length ? grant.missing : userGrantScopes;
      }

      const loginScopes = notice.authReason === "user_grant" ? requiredScopes : missing;
      const login = await startLogin(loginScopes, { accountId: notice.accountId }, {
        identity: notice.identity,
        authReason: notice.authReason,
        requiredScopes,
        scopeInstallGrant,
        scopeInstallGrants,
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
        scopeGrantDual: login.scopeGrantDual,
        userScopeCount: notice.requiredScopes?.length || notice.missing?.length || null,
        ...(oauthState ? { oauthState } : {}),
      });
      if (sent.messageId) {
        clearPendingAuthNotice(authTargetKey);
        skillAuthCache.set(authTargetKey, {
          missingKey: notice.missingKey,
          lastSentAtMs: Date.now(),
          requesterKey: notice.requesterKey,
          authMessageId: sent.messageId,
        });
        rememberAuthCardPollSession({
          authTargetKey,
          skillName: notice.skillName,
          messageId: sent.messageId,
          accountId: notice.accountId,
          authReason: notice.authReason,
          requesterKey: notice.requesterKey,
          deviceCode: login.deviceCode,
          missingKey: notice.missingKey,
          missing,
          requiredScopes,
          identity: notice.identity,
          openId: notice.openId,
        });
        fileLog(`pendingAuth retry sent "${notice.skillName}" msg=${sent.messageId}`);
        startWaitForAuth({
          authTargetKey,
          skillName: notice.skillName,
          deviceCode: login.deviceCode,
          missingKey: notice.missingKey,
          openId: notice.openId,
          scopes: missing,
          requiredScopes,
          scopeInstallGrant,
          scopeInstallGrants,
          identity: notice.identity,
          authReason: notice.authReason,
          ...(oauthState ? { oauthState } : {}),
          ctx: { accountId: notice.accountId },
          authMessageId: sent.messageId,
          authWaiter: login.authWaiter,
          ...buildSkillAuthWaitCallbacks(authTargetKey, notice.requesterKey),
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
      timer?.unref?.();
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
      augmentHookRoutingContext(event, ctx);
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
      cacheTrustedSenderFromHook(event, ctx, "before_prompt_build");
      rememberLatestUserText(event, ctx);

      // A Skill may already be described in the model prompt, in which case the
      // model can answer without reading SKILL.md or making a tool call.  Preflight
      // only when the user explicitly names a registered Skill, and reuse the exact
      // same guarded read path used for normal runtime execution.
      if (ctx?.messageProvider === "feishu" || ctx?.channel === "feishu") {
        const skillMapEntry = getSkillMapEntry(ctx);
        const explicitSkillNames = findExplicitSkillNames(event, skillMapEntry.map, ctx);
        const pendingGate = getAuthExecutionGate(event, ctx);
        const resolvableSkillNames = explicitSkillNames.filter((skillName) =>
          [...skillMapEntry.map.values()].some((candidateSkillName) => candidateSkillName === skillName),
        );
        const restartAfterReject = pendingGate?.rejected === true && resolvableSkillNames.length > 0;
        if (pendingGate?.rejected && !restartAfterReject) {
          fileLog(`before_prompt_build rejected gate blocks all skills pending="${pendingGate.skillName}"`);
          if (blockRead) return blockForPendingAuthorization(pendingGate.skillName, pendingGate);
        }
        if (restartAfterReject) {
          clearPendingAuthNotice(pendingGate.authTargetKey);
          skillAuthCache.delete(pendingGate.authTargetKey);
          clearAuthExecutionGates(pendingGate.authTargetKey);
          fileLog(
            `rejected gate cleared for explicit skill retry pending="${pendingGate.skillName}" skills=${resolvableSkillNames.join(",")}`,
          );
        }
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
            authIntent: { type: "explicit_skill_retry", skillName, restartAfterReject },
            skillCommand: { skillName },
          });
          if (result?.block) return result;
        }
      }
    });

    api.on("message_received", async (event, ctx) => {
      augmentHookRoutingContext(event, ctx);
      const acc = getAccountId(ctx) || event?.accountId || ctx?.accountId || ctx?.account || null;
      const sid = ctx?.sessionId || event?.sessionId || null;
      const skey = ctx?.sessionKey || event?.sessionKey || null;
      fileLog(`message_received accountId=${acc || "<none>"} sessionId=${sid || "<none>"} sessionKey=${skey || "<none>"} eventKeys=${event ? JSON.stringify(Object.keys(event)) : "null"}`);
      fileLog(`message_received summary=${safeJson(buildHookDebugSummary(event, ctx))}`);
      if (acc) {
        if (sid) cachedAccountBySession.set(sid, acc);
        if (skey) cachedAccountBySession.set(skey, acc);
      }
      cacheTrustedSenderFromHook(event, { ...ctx, sessionId: sid || ctx?.sessionId, sessionKey: skey || ctx?.sessionKey }, "message_received");
      rememberLatestUserText(event, { ...ctx, sessionId: sid || ctx?.sessionId, sessionKey: skey || ctx?.sessionKey });
      const installAuthConfig = normalizeInstallAuthConfig({ ...ctx, sessionId: sid || ctx?.sessionId, sessionKey: skey || ctx?.sessionKey });
      if (installAuthConfig?.source === "hook-sender") {
        void runInstallAuthPreflight({ ...ctx, sessionId: sid || ctx?.sessionId, sessionKey: skey || ctx?.sessionKey }).catch((error) => {
          fileLog(`installAuth message retry failed: ${error?.message || error}`);
        });
      }
    });

    async function guardToolCall(event, ctx) {
      let guardedSkillName = null;
      try {
        logCtxSnapshotOnce(ctx);
        fileLog(`hook: tool=${event?.toolName || ""} channel=${ctx?.channel || ""} path=${event?.params?.path || ""}`);
        fileLog(`before_tool_call summary=${safeJson(buildHookDebugSummary(event, ctx))}`);
        if (ctx && ctx.channel && ctx.channel !== "feishu") return;
        augmentHookRoutingContext(event, ctx);
        const rawPath = event.params?.path;
        const wsDir = resolveWorkspaceDir(ctx);
        const directTarget = resolveSkillReadTarget(rawPath, ctx?.cwd, wsDir);
        const skillNameCandidates = collectSkillNameCandidates(event, ctx, directTarget);
        const isReadTool = event.toolName === "read";
        let pendingGate = getAuthExecutionGate(event, ctx);
        if (pendingGate && releaseStaleAuthExecutionGate(pendingGate)) {
          pendingGate = getAuthExecutionGate(event, ctx);
        }
        const explicitRetryName = ctx?.authIntent?.type === "explicit_skill_retry"
          ? normalizeSkillName(ctx.authIntent.skillName)
          : null;
        if (pendingGate?.rejected && !explicitRetryName) {
          fileLog(`auth gate rejected all skills tool=${event?.toolName || ""} pending="${pendingGate.skillName}"`);
          return blockRead ? blockForPendingAuthorization(pendingGate.skillName, pendingGate) : undefined;
        }
        if (pendingGate?.rejected && explicitRetryName) {
          clearPendingAuthNotice(pendingGate.authTargetKey);
          skillAuthCache.delete(pendingGate.authTargetKey);
          clearAuthExecutionGates(pendingGate.authTargetKey);
          pendingGate = null;
          fileLog(`auth gate rejected cleared by explicit retry skill="${explicitRetryName}"`);
        }
        if (pendingGate && skillNameCandidates.includes(pendingGate.skillName) && !hasExplicitRetryIntent(ctx, pendingGate.skillName)) {
          const pollingActive = isAuthPollingActiveForTarget(pendingGate);
          const { waitRemainingMs } = describeAuthGateWait(pendingGate);
          const pollSnapshot = getAuthPollingSnapshot(pendingGate.authTargetKey);
          fileLog(
            `auth gate held tool=${event?.toolName || ""} skill="${pendingGate.skillName}" pollingActive=${pollingActive} waitRemainingMs=${waitRemainingMs} lastPollAgeMs=${pollSnapshot?.lastPollAtMs ? Date.now() - pollSnapshot.lastPollAtMs : "<none>"}`,
          );
          return blockRead ? blockForPendingAuthorization(pendingGate.skillName, pendingGate) : undefined;
        }
        if (pendingGate && !skillNameCandidates.includes(pendingGate.skillName) && isProtectedPendingAuthOperation(event, pendingGate, directTarget, skillNameCandidates)) {
          fileLog(`auth gate blocked tool=${event?.toolName || ""} skill="${pendingGate.skillName}"`);
          return blockRead ? blockForPendingAuthorization(pendingGate.skillName, pendingGate) : undefined;
        }
        if (!isReadTool && skillNameCandidates.length === 0) return;
        if (isReadTool) {
          fileLog(`hook: read-enter rawPath=${event?.params?.path || ""} cwd=${ctx?.cwd || ""}`);
        } else {
          fileLog(`hook: skill-runtime-enter tool=${event?.toolName || ""} skillCandidates=${skillNameCandidates.join(",") || "<none>"}`);
        }
        if (!rawPath && skillNameCandidates.length === 0) return;
        cacheTrustedSenderFromHook(event, ctx, "before_tool_call");
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
        const requestedSkillName = normalizeSkillName(ctx?.authIntent?.skillName)
          || normalizeSkillName(ctx?.skillCommand?.skillName);
        if (requestedSkillName) {
          let requestedPath = null;
          for (const [candidatePath, candidateSkillName] of skillMapEntry.map.entries()) {
            if (candidateSkillName === requestedSkillName) {
              requestedPath = candidatePath;
              break;
            }
          }
          if (requestedPath) {
            if (skillName !== requestedSkillName) {
              fileLog(`skill name aligned to explicit request "${requestedSkillName}" from "${skillName || "<none>"}"`);
            }
            skillName = requestedSkillName;
            skillPath = requestedPath;
          }
        }
        const declaredAuth = readLarkAuth(skillPath);
        if (!declaredAuth || !declaredAuth.scopes.length) return;
        const expandedAuth = expandLarkAuthWithManagedSkills(declaredAuth, { skillPath });
        const larkAuth = expandedAuth.auth || declaredAuth;
        if (expandedAuth.bundled) {
          fileLog(
            `larkAuth bundled managedRoot=${expandedAuth.managedRoot || "<none>"} skillCount=${expandedAuth.skillCount || 0} scopes=${larkAuth.scopes.join(",")}`,
          );
        }
        guardedSkillName = skillName;
        const identity = normalizeAuthIdentity(larkAuth.identity);
        let resolvedUser = identity === "user" ? await getAuthedUser(ctx).catch(() => null) : null;
        const requesterKey = identity === "user"
          ? (resolvedUser?.openId || getCachedSenderId(ctx) || getSessionGateKeys(event, ctx)[0] || null)
          : null;
        const authTargetKey = expandedAuth.bundled
          ? `${getAccountId(ctx) || "unknown"}::openclaw-managed-skills`
          : getSkillAuthCacheKey(skillPath, ctx);

        const runtime = await ensureFeishuRuntimeHealth(ctx);
        if (!runtime.ok) {
          const reason = `技能「${skillName}」依赖的飞书运行时当前不可用，无法完成权限校验。${runtime.recoveryHint || "请补齐 Feishu 应用凭据后重试。"}`;
          fileLog(`runtime blocked skill="${skillName}" reason=${reason}`);
          return blockRead ? { block: true, reason } : undefined;
        }
        if (runtime.accountId) {
          augmentCtxWithFeishuAccount(ctx, runtime.accountId);
        }

        const appScopeEntries = await getAppScopeEntries(ctx, { forceRefresh: true }).catch(() => null);
        const appScopeCheck = await checkScopes(larkAuth.scopes, ctx, {
          identity,
          appScopeEntries,
          scopeInstallGrant: larkAuth.scopeInstallGrant,
          scopeInstallGrants: larkAuth.scopeInstallGrants,
        });
        let authReason = "app_scope";
        let missing = appScopeCheck.missing?.length ? appScopeCheck.missing : [];
        let userGrantCheck = null;
        let userGrantAlreadyComplete = false;
        const userGrantScopes = filterScopesNeedingUserGrant(larkAuth.scopes, appScopeEntries, {
          scopeInstallGrant: larkAuth.scopeInstallGrant,
          scopeInstallGrants: larkAuth.scopeInstallGrants,
        });

        if (appScopeCheck.ok && identity === "app") {
          await reconcileOutstandingAuthCard({
            authTargetKey,
            skillName,
            accountId: getAccountId(ctx),
            userGrantComplete: false,
            authReason: "app_scope",
          });
          clearPendingAuthNotice(authTargetKey);
          skillAuthCache.delete(authTargetKey);
          clearAuthExecutionGates(authTargetKey);
          return;
        }

        if (appScopeCheck.ok && identity === "user") {
          const fullMissingKey = larkAuth.scopes.slice().sort().join("|");
          if (!userGrantScopes.length) {
            fileLog(`skill="${skillName}" app scopes are open; no user OAuth scopes declared (appScopes-only)`);
            await reconcileOutstandingAuthCard({
              authTargetKey,
              skillName,
              accountId: getAccountId(ctx),
              userGrantComplete: true,
              authReason: "app_scope",
            });
            clearPendingAuthNotice(authTargetKey);
            clearAuthExecutionGates(authTargetKey);
            skillAuthCache.set(authTargetKey, {
              missingKey: fullMissingKey,
              lastSentAtMs: Date.now(),
              authorized: true,
              authReason: "app_scope",
            });
            fileLog(`skill="${skillName}" authorized with app scopes only (no user grant)`);
            return;
          }
          fileLog(`skill="${skillName}" app scopes are open; checking user grant with scope details`);
          userGrantCheck = await checkUserGrant(resolvedUser?.openId, userGrantScopes, ctx, { requireScopeDetails: true });
          if (userGrantCheck.ok) {
            await reconcileOutstandingAuthCard({
              authTargetKey,
              skillName,
              accountId: getAccountId(ctx),
              userGrantComplete: true,
              authReason: "app_scope",
            });
            clearPendingAuthNotice(authTargetKey);
            clearAuthExecutionGates(authTargetKey);
            const finalized = skillAuthCache.get(authTargetKey);
            skillAuthCache.set(authTargetKey, {
              missingKey: fullMissingKey,
              lastSentAtMs: Date.now(),
              authorized: true,
              authReason: "user_grant",
              authMessageId: finalized?.authMessageId,
              cardFinalized: finalized?.cardFinalized === true,
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
          missing = userGrantCheck.missing?.length ? userGrantCheck.missing : userGrantScopes;
          fileLog(`skill="${skillName}" user grant missing or unverifiable: ${missing.join(", ")} reason=${userGrantCheck.reason || "not granted"}`);
        } else {
          missing = missing.length ? missing : larkAuth.scopes;
          fileLog(`skill="${skillName}" app ${identity} scopes missing: ${missing.join(", ")}`);
          if (identity === "user" && userGrantScopes.length > 0) {
            if (!resolvedUser?.openId) {
              resolvedUser = await getAuthedUser(ctx).catch(() => null);
            }
            const precheck = await checkUserGrant(resolvedUser?.openId, userGrantScopes, ctx, {
              requireScopeDetails: true,
            }).catch(() => null);
            if (precheck?.ok) {
              userGrantAlreadyComplete = true;
              fileLog(
                `skill="${skillName}" user grant already authorized while app scopes missing; use app-only auth card copy`,
              );
            }
          }
        }

        api.log?.info?.(`[openclaw-skill-runtime] skill="${skillName}" identity=${identity} authReason=${authReason} missing: ${missing.join(", ")}`);
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
        if (ctx?.authIntent?.restartAfterReject !== true && cache && cache.authorized !== true && cache.requesterKey === requesterKey && cache.missingKey === missingKey && (now - cache.lastSentAtMs) < 180000) {
          if (!cache.retryConsumed && hasExplicitRetryIntent(ctx, skillName)) {
            skillAuthCache.set(authTargetKey, { ...cache, retryConsumed: true });
            fileLog(`retry: authTargetKey="${authTargetKey}" explicit user retry allowed during cooldown`);
          } else {
            fileLog(`skip: authTargetKey="${authTargetKey}" cooldown active (${Math.round((now - cache.lastSentAtMs) / 1000)}s ago)`);
            return blockRead ? { block: true, reason: `技能「${skillName}」需要飞书权限授权，上次已发送授权卡片，请完成授权后重试。` } : undefined;
          }
        }

        let loginError = null;
        const oauthState = authReason === "user_grant" ? userGrantCheck?.oauthState || null : null;
        const loginScopes = authReason === "user_grant" ? larkAuth.scopes : missing;
        const login = await startLogin(loginScopes, ctx, {
          identity,
          authReason,
          requiredScopes: larkAuth.scopes,
          scopeInstallGrant: larkAuth.scopeInstallGrant,
          scopeInstallGrants: larkAuth.scopeInstallGrants,
          oauthState,
        });
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
            userScopeCount:
              authReason === "app_scope" && identity === "user" && !userGrantAlreadyComplete
                ? userGrantScopes.length
                : null,
            userGrantAlreadyComplete,
            ...(oauthState ? { oauthState } : {}),
          });
          if (sent.messageId) {
            clearPendingAuthNotice(authTargetKey);
            skillAuthCache.set(authTargetKey, {
              missingKey,
              lastSentAtMs: now,
              requesterKey,
              authReason,
              authMessageId: sent.messageId,
              retryConsumed: skillAuthCache.get(authTargetKey)?.retryConsumed === true,
            });
            rememberAuthCardPollSession({
              authTargetKey,
              skillName,
              messageId: sent.messageId,
              accountId: resolvedAccountId,
              authReason,
              requesterKey,
              deviceCode: login.deviceCode,
              missingKey,
              missing,
              requiredScopes: larkAuth.scopes,
              scopeInstallGrant: larkAuth.scopeInstallGrant,
              scopeInstallGrants: larkAuth.scopeInstallGrants,
              identity,
              openId: user?.openId,
            });
            const mode = blockRead ? "(blocked)" : "";
            fileLog(
              `auth card ${mode} "${skillName}" sent msg=${sent.messageId} deviceCodePresent=${login.deviceCode ? "yes" : "no"} build=${PLUGIN_RUNTIME_BUILD}`,
            );
            openAuthExecutionGate(authTargetKey, skillName, event, ctx, requesterKey);
            refreshAuthExecutionGateWait(authTargetKey);
            startWaitForAuth({
              authTargetKey,
              skillName,
              deviceCode: login.deviceCode,
              missingKey,
              openId: user?.openId,
              scopes: missing,
              requiredScopes: larkAuth.scopes,
              scopeInstallGrant: larkAuth.scopeInstallGrant,
              scopeInstallGrants: larkAuth.scopeInstallGrants,
              identity,
              authReason,
              ...(oauthState ? { oauthState } : {}),
              ctx: {
                ...ctx,
                accountId: getAccountId(ctx) || runtime.accountId || null,
                account: getAccountId(ctx) || runtime.accountId || null,
                appId: runtime.appId || ctx?.appId || null,
                feishuAppId: runtime.appId || ctx?.feishuAppId || null,
              },
              authMessageId: sent.messageId,
              authWaiter: login.authWaiter,
              ...buildSkillAuthWaitCallbacks(authTargetKey, requesterKey),
            });
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

    async function sendInstallAuthForApp(app, manifest, installAuthConfig) {
      const larkAuth = buildManifestAppAuth(app);
      if (!larkAuth?.scopes?.length) return;
      const accountId = app.accountId || null;
      if (!accountId) {
        fileLog(`installAuth skipped app=${app.key || "<unknown>"} reason=missing-accountId`);
        return;
      }
      const authTargetKey = `${accountId}::install-auth::${app.key || accountId}`;
      const ctx = {
        accountId,
        account: accountId,
        appId: app.appId || null,
        feishuAppId: app.appId || null,
      };
      const runtime = await ensureFeishuRuntimeHealth(ctx);
      if (!runtime.ok) {
        fileLog(`installAuth skipped app=${app.key || accountId} reason=runtime-unavailable error=${runtime.error || "unknown"}`);
        return;
      }
      if (runtime.accountId) augmentCtxWithFeishuAccount(ctx, runtime.accountId);

      const appScopeEntries = await getAppScopeEntries(ctx, { forceRefresh: true }).catch(() => null);
      const appScopeCheck = await checkScopes(larkAuth.scopes, ctx, {
        identity: larkAuth.identity,
        appScopeEntries,
        scopeInstallGrant: larkAuth.scopeInstallGrant,
        scopeInstallGrants: larkAuth.scopeInstallGrants,
      });
      const userGrantScopes = filterScopesNeedingUserGrant(larkAuth.scopes, appScopeEntries, {
        scopeInstallGrant: larkAuth.scopeInstallGrant,
        scopeInstallGrants: larkAuth.scopeInstallGrants,
      });

      let authReason = "app_scope";
      let missing = appScopeCheck.missing?.length ? appScopeCheck.missing : [];
      let oauthState = null;
      if (appScopeCheck.ok && larkAuth.identity === "app") {
        fileLog(`installAuth app=${app.key || accountId} already authorized for app identity`);
        return;
      }

      let recipient = { ...installAuthConfig };
      if (!recipient.receiveId || larkAuth.identity === "user") {
        const resolvedRecipient = await resolveInstallAuthRecipient(ctx, {
          ...(recipient.openId ? { openId: recipient.openId } : {}),
          ...(recipient.profile ? { profile: recipient.profile } : {}),
        }).catch((error) => ({
          ok: false,
          reasonCode: "runtime_unavailable",
          detail: error?.message || String(error),
        }));
        if (!resolvedRecipient?.ok) {
          fileLog(`installAuth skipped app=${app.key || accountId} reason=${resolvedRecipient?.reasonCode || "recipient_unavailable"}`);
          return;
        }
        recipient = {
          receiveId: recipient.receiveId || resolvedRecipient.openId,
          receiveIdType: "open_id",
          openId: recipient.openId || resolvedRecipient.openId,
          profile: resolvedRecipient.profile,
        };
      }

      const runKey = `${manifest.hash || "nohash"}::${authTargetKey}::${recipient.receiveId}`;
      if (installAuthRunKeys.has(runKey)) {
        fileLog(`installAuth skipped duplicate authTargetKey="${authTargetKey}"`);
        return;
      }
      installAuthRunKeys.add(runKey);

      if (appScopeCheck.ok && larkAuth.identity === "user") {
        if (!userGrantScopes.length) {
          fileLog(`installAuth app=${app.key || accountId} already authorized; no user OAuth scopes`);
          return;
        }
        if (!recipient.openId) {
          fileLog(`installAuth skipped app=${app.key || accountId} reason=user-scope-openId-missing`);
          return;
        }
        const userGrantCheck = await checkUserGrant(
          recipient.openId,
          userGrantScopes,
          ctx,
          { requireScopeDetails: true, larkProfile: recipient.profile },
        ).catch(() => null);
        if (userGrantCheck?.ok) {
          fileLog(`installAuth app=${app.key || accountId} already authorized for user grant`);
          return;
        }
        authReason = "user_grant";
        missing = userGrantCheck?.missing?.length ? userGrantCheck.missing : userGrantScopes;
        oauthState = userGrantCheck?.oauthState || null;
      } else {
        missing = missing.length ? missing : larkAuth.scopes;
      }

      const missingKey = (authReason === "user_grant" ? larkAuth.scopes : missing).slice().sort().join("|");
      const loginScopes = authReason === "user_grant" ? larkAuth.scopes : missing;
      const login = await startLogin(loginScopes, ctx, {
        identity: larkAuth.identity,
        authReason,
        requiredScopes: larkAuth.scopes,
        scopeInstallGrant: larkAuth.scopeInstallGrant,
        scopeInstallGrants: larkAuth.scopeInstallGrants,
        larkProfile: recipient.profile,
        ...(oauthState ? { oauthState } : {}),
      });
      if (!login?.verificationUrl) {
        fileLog(`installAuth startLogin failed app=${app.key || accountId}: ${login?.error || "unknown"}`);
        return;
      }

      const sent = await sendAuthCard({
        skillName: "openclaw-managed-skills",
        missing,
        ...login,
        openId: recipient.openId,
        receiveId: recipient.receiveId,
        receiveIdType: recipient.receiveIdType,
        accountId,
        identity: larkAuth.identity,
        authReason,
        scopeGrantDual: login.scopeGrantDual,
        userScopeCount: authReason === "app_scope" && larkAuth.identity === "user" ? userGrantScopes.length : null,
        ...(oauthState ? { oauthState } : {}),
      });
      if (!sent.messageId) {
        fileLog(`installAuth sendAuthCard failed app=${app.key || accountId}: ${sent.error || "unknown"}`);
        return;
      }

      skillAuthCache.set(authTargetKey, {
        missingKey,
        lastSentAtMs: Date.now(),
        requesterKey: recipient.openId || recipient.receiveId,
        authReason,
        authMessageId: sent.messageId,
      });
      rememberAuthCardPollSession({
        authTargetKey,
        skillName: "openclaw-managed-skills",
        messageId: sent.messageId,
        accountId,
        authReason,
        requesterKey: recipient.openId || recipient.receiveId,
        deviceCode: login.deviceCode,
        missingKey,
        missing,
        requiredScopes: larkAuth.scopes,
        scopeInstallGrant: larkAuth.scopeInstallGrant,
        identity: larkAuth.identity,
        openId: recipient.openId,
        larkProfile: recipient.profile,
      });
      fileLog(
        `installAuth card sent app=${app.key || accountId} msg=${sent.messageId} scopes=${larkAuth.scopes.length} build=${PLUGIN_RUNTIME_BUILD}`,
      );
      startWaitForAuth({
        authTargetKey,
        skillName: "openclaw-managed-skills",
        deviceCode: login.deviceCode,
        missingKey,
        openId: recipient.openId,
        larkProfile: recipient.profile,
        scopes: missing,
        requiredScopes: larkAuth.scopes,
        scopeInstallGrant: larkAuth.scopeInstallGrant,
        scopeInstallGrants: larkAuth.scopeInstallGrants,
        identity: larkAuth.identity,
        authReason,
        ...(oauthState ? { oauthState } : {}),
        ctx,
        authMessageId: sent.messageId,
        authWaiter: login.authWaiter,
        ...buildSkillAuthWaitCallbacks(authTargetKey, recipient.openId || recipient.receiveId),
      });
    }

    async function runInstallAuthPreflight(ctx = null) {
      const installAuthConfig = normalizeInstallAuthConfig(ctx);
      if (!installAuthConfig) return;
      const manifest = collectSkillAuthManifest({
        config: activeApiConfig || {},
        pluginConfig: cfg,
        skillRoots: getInstallAuthSkillRoots(),
      });
      fileLog(
        `installAuth manifest complete=${manifest.complete} apps=${manifest.apps.length} skills=${manifest.totals?.skills || 0} skillsWithAuth=${manifest.totals?.skillsWithAuth || 0} unresolved=${manifest.unresolved.length} errors=${manifest.errors.length}`,
      );
      if (manifest.errors.length) {
        fileLog(`installAuth manifest errors=${safeJson(manifest.errors.slice(0, 10))}`);
      }
      if (manifest.unresolved.length) {
        fileLog(`installAuth manifest unresolved=${safeJson(manifest.unresolved.slice(0, 10))}`);
      }
      for (const app of manifest.apps) {
        await sendInstallAuthForApp(app, manifest, installAuthConfig);
      }
    }

    api.on("before_tool_call", guardToolCall, { priority: 80, timeoutMs: 40000 });
    resumeOutstandingAuthPolls();
    setImmediate(() => {
      void runInstallAuthPreflight().catch((error) => {
        fileLog(`installAuth failed: ${error?.message || error}`);
      });
    });
    },
  };
}

export default createPluginEntry();
