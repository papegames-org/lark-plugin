import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createPluginEntry } from "../index.js";
import { resolveSkillReadTarget } from "../utils.js";

const basicSkillPath = fileURLToPath(new URL("./fixtures/skills/feishu-auth-basic/SKILL.md", import.meta.url));

test("before_tool_call sends auth card for direct OpenClaw test skill reads", async () => {
  const handlers = new Map();
  const senderBySession = new Map();
  const captured = {
    sendAuthCard: [],
    startWaitForAuth: [],
  };

  const cacheSenderId = (ctx, senderId) => {
    if (!senderId) return;
    if (ctx?.sessionId) senderBySession.set(ctx.sessionId, senderId);
    if (ctx?.sessionKey) senderBySession.set(ctx.sessionKey, senderId);
  };

  const getCachedSenderId = (ctx) => {
    if (ctx?.senderId) return ctx.senderId;
    if (ctx?.sessionId && senderBySession.has(ctx.sessionId)) return senderBySession.get(ctx.sessionId);
    if (ctx?.sessionKey && senderBySession.has(ctx.sessionKey)) return senderBySession.get(ctx.sessionKey);
    return null;
  };

  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() {
      return "/tmp/openclaw-skill-runtime-index-test.json";
    },
    readPendingAuthNoticeStore() {
      return new Map();
    },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() {
      return "test-roots";
    },
    getDefaultSkillRoots() {
      return [];
    },
    buildSkillMap() {
      // Force the hook to rely on direct SKILL.md path recognition instead of the index.
      return new Map();
    },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId,
    getCachedSenderId,
    resolveWorkspaceDir() {
      return null;
    },
    resolveSkillReadTarget,
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      granted: [],
    }),
    startLogin: async () => ({
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async (ctx) => {
      const openId = getCachedSenderId(ctx);
      return openId ? { openId } : null;
    },
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_123" };
    },
    startWaitForAuth(payload) {
      captured.startWaitForAuth.push(payload);
    },
  });

  plugin.register({
    config: {
      channels: {
        feishu: {
          accounts: {
            "acc-a": {
              appId: "cli_test",
              appSecret: "secret_test",
            },
          },
        },
      },
    },
    pluginConfig: {
      enabled: true,
      blockRead: true,
    },
    log: {
      info() {},
      warn() {},
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get("message_received")(
    {
      accountId: "acc-a",
      senderId: "ou_test_123",
    },
    {
      sessionId: "session-a",
      sessionKey: "session-key-a",
      channel: "feishu",
    },
  );

  const result = await handlers.get("before_tool_call")(
    {
      toolName: "read",
      params: {
        path: basicSkillPath,
      },
    },
    {
      channel: "feishu",
      sessionId: "session-a",
      sessionKey: "session-key-a",
      accountId: "acc-a",
      cwd: "/",
    },
  );

  assert.deepEqual(captured.sendAuthCard, [
    {
      skillName: "feishu-auth-basic",
      missing: ["contact:user.base:readonly"],
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
      openId: "ou_test_123",
      receiveId: "ou_test_123",
      receiveIdType: "open_id",
      accountId: "acc-a",
      identity: "user",
      authReason: "app_scope",
    },
  ]);
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(captured.startWaitForAuth[0].skillName, "feishu-auth-basic");
  assert.equal(captured.startWaitForAuth[0].openId, "ou_test_123");
  assert.equal(captured.startWaitForAuth[0].identity, "user");
  assert.equal(captured.startWaitForAuth[0].authReason, "app_scope");
  assert.equal(result?.block, true);
  assert.match(result?.reason || "", /已发送授权卡片/);
});

test("before_prompt_build preflights an explicitly named skill and sends its auth card", async () => {
  const handlers = new Map();
  const captured = { cards: [] };
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-prompt-preflight.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_prompt_preflight"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: false, missing: ["contact:user.base:readonly"], granted: [] }),
    startLogin: async () => ({ verificationUrl: "https://example.com/auth", userCode: "PROMPT", deviceCode: "PROMPT_DEVICE" }),
    getAuthedUser: async () => ({ openId: "ou_prompt_preflight" }),
    sendAuthCard: async (payload) => {
      captured.cards.push(payload);
      return { messageId: "msg_prompt_preflight" };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  await handlers.get("before_prompt_build")(
    { messages: [{ role: "user", content: "请执行 feishu-auth-basic skill" }] },
    { channel: "feishu", accountId: "acc-a", sessionId: "prompt-session", sessionKey: "prompt-session" },
  );

  assert.equal(captured.cards.length, 1);
  assert.equal(captured.cards[0].skillName, "feishu-auth-basic");
  assert.equal(captured.cards[0].openId, "ou_prompt_preflight");
});

test("before_tool_call deduplicates replacement auth cards during the cooldown", async () => {
  const handlers = new Map();
  const captured = { loginCount: 0, cards: [] };
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-one-retry.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_one_retry_123"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: false, missing: ["contact:user.base:readonly"], granted: [] }),
    startLogin: async () => ({
      verificationUrl: `https://example.com/auth/${++captured.loginCount}`,
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async () => ({ openId: "ou_one_retry_123" }),
    sendAuthCard: async (payload) => {
      captured.cards.push(payload);
      return { messageId: `msg_${captured.cards.length}` };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const event = { toolName: "read", params: { path: basicSkillPath } };
  const ctx = { channel: "feishu", accountId: "acc-a", skillCommand: { skillName: "feishu-auth-basic" } };
  const first = await handlers.get("before_tool_call")(event, ctx);
  const second = await handlers.get("before_tool_call")(event, ctx);
  const third = await handlers.get("before_tool_call")(event, ctx);

  assert.equal(first?.block, true);
  assert.equal(second?.block, true);
  assert.equal(third?.block, true);
  assert.equal(captured.loginCount, 1);
  assert.equal(captured.cards.length, 1);
});

test("before_tool_call can resolve the test skill from ctx.skillCommand when read path is unavailable", async () => {
  const handlers = new Map();
  const captured = {
    sendAuthCard: [],
  };

  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() {
      return "/tmp/openclaw-skill-runtime-index-test-skill-command.json";
    },
    readPendingAuthNoticeStore() {
      return new Map();
    },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() {
      return "test-roots";
    },
    getDefaultSkillRoots() {
      return [];
    },
    buildSkillMap() {
      return new Map([[basicSkillPath, "feishu-auth-basic"]]);
    },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() {
      return "ou_skill_command_123";
    },
    resolveWorkspaceDir() {
      return null;
    },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      granted: [],
    }),
    startLogin: async () => ({
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async () => ({ openId: "ou_skill_command_123" }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_skill_command_123" };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: {
      channels: {
        feishu: {
          accounts: {
            "acc-a": {
              appId: "cli_test",
              appSecret: "secret_test",
            },
          },
        },
      },
    },
    pluginConfig: {
      enabled: true,
      blockRead: true,
    },
    log: {
      info() {},
      warn() {},
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  const result = await handlers.get("before_tool_call")(
    {
      toolName: "read",
      params: {},
    },
    {
      channel: "feishu",
      sessionId: "session-a",
      sessionKey: "session-key-a",
      accountId: "acc-a",
      skillCommand: {
        skillName: "feishu-auth-basic",
      },
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-basic");
  assert.equal(captured.sendAuthCard[0].openId, "ou_skill_command_123");
  assert.equal(result?.block, true);
});

test("before_tool_call can infer the Feishu recipient from channelId for direct skill reads", async () => {
  const handlers = new Map();
  const captured = {
    sendAuthCard: [],
  };

  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() {
      return "/tmp/openclaw-skill-runtime-index-test-channel-id.json";
    },
    readPendingAuthNoticeStore() {
      return new Map();
    },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() {
      return "test-roots";
    },
    getDefaultSkillRoots() {
      return [];
    },
    buildSkillMap() {
      return new Map();
    },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId(ctx) {
      return ctx?.senderId || ctx?.channelId || null;
    },
    resolveWorkspaceDir() {
      return null;
    },
    resolveSkillReadTarget,
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      granted: [],
    }),
    startLogin: async () => ({
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async (ctx) => ({ openId: ctx?.senderId || ctx?.channelId || null }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_channel_id_123" };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: {
      channels: {
        feishu: {
          accounts: {
            "acc-a": {
              appId: "cli_test",
              appSecret: "secret_test",
            },
          },
        },
      },
    },
    pluginConfig: {
      enabled: true,
      blockRead: true,
    },
    log: {
      info() {},
      warn() {},
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  const result = await handlers.get("before_tool_call")(
    {
      toolName: "read",
      params: {
        path: basicSkillPath,
      },
    },
    {
      messageProvider: "feishu",
      channelId: "ou_channel_fallback_123",
      sessionId: "session-channel-id",
      accountId: "acc-a",
      cwd: "/",
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].openId, "ou_channel_fallback_123");
  assert.equal(captured.sendAuthCard[0].accountId, "acc-a");
  assert.equal(result?.block, true);
});

test("before_tool_call can authorize skill runtime invocations without a read tool call", async () => {
  const handlers = new Map();
  const captured = {
    sendAuthCard: [],
    startWaitForAuth: [],
  };

  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() {
      return "/tmp/openclaw-skill-runtime-index-test-trace-skill-command.json";
    },
    readPendingAuthNoticeStore() {
      return new Map();
    },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() {
      return "test-roots";
    },
    getDefaultSkillRoots() {
      return [];
    },
    buildSkillMap() {
      return new Map([[basicSkillPath, "feishu-auth-basic"]]);
    },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() {
      return "ou_trace_skill_command_123";
    },
    resolveWorkspaceDir() {
      return null;
    },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      granted: [],
    }),
    startLogin: async () => ({
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async () => ({ openId: "ou_trace_skill_command_123" }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_trace_skill_command_123" };
    },
    startWaitForAuth(payload) {
      captured.startWaitForAuth.push(payload);
    },
  });

  plugin.register({
    config: {
      channels: {
        feishu: {
          accounts: {
            "acc-a": {
              appId: "cli_test",
              appSecret: "secret_test",
            },
          },
        },
      },
    },
    pluginConfig: {
      enabled: true,
      blockRead: true,
    },
    log: {
      info() {},
      warn() {},
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  const result = await handlers.get("before_tool_call")(
    {
      toolName: "exec",
      params: {
        command: "echo test",
      },
    },
    {
      sessionId: "session-trace-skill-command",
      sessionKey: "session-key-trace-skill-command",
      accountId: "acc-a",
      trace: {
        skillCommand: {
          skillName: "feishu-auth-basic",
        },
      },
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-basic");
  assert.equal(captured.sendAuthCard[0].openId, "ou_trace_skill_command_123");
  assert.equal(captured.sendAuthCard[0].accountId, "acc-a");
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(result?.block, true);
});

test("before_tool_call sends user-grant card when app scopes are open but user grant is unverifiable", async () => {
  const handlers = new Map();
  const captured = { sendAuthCard: [], checkUserGrant: [], startWaitForAuth: [] };
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-user-grant.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_user_grant_123"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async (_scopes, _ctx, options) => ({ ok: true, missing: [], granted: _scopes, identity: options.identity }),
    checkUserGrant: async (openId, scopes, _ctx, options) => {
      captured.checkUserGrant.push({ openId, scopes, options });
      return {
        ok: false,
        missing: scopes,
        granted: [],
        reason: options?.requireScopeDetails ? "user grant check did not include granted scope details" : "missing user grant",
      };
    },
    startLogin: async (_missing, _ctx, options) => ({ verificationUrl: "https://example.com/user-auth", userCode: "USER", deviceCode: "DEVICE", identity: options.identity }),
    getAuthedUser: async () => ({ openId: "ou_user_grant_123" }),
    sendAuthCard: async (payload) => { captured.sendAuthCard.push(payload); return { messageId: "msg_user_grant" }; },
    startWaitForAuth(payload) { captured.startWaitForAuth.push(payload); },
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a", skillCommand: { skillName: "feishu-auth-basic" } });

  assert.equal(captured.checkUserGrant.length, 1);
  assert.equal(captured.checkUserGrant[0].openId, "ou_user_grant_123");
  assert.equal(captured.checkUserGrant[0].options?.requireScopeDetails, true);
  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].identity, "user");
  assert.equal(captured.sendAuthCard[0].authReason, "user_grant");
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(typeof captured.startWaitForAuth[0].onAuthorized, "function");
  assert.equal(result?.block, true);

  await captured.startWaitForAuth[0].onAuthorized({
    authTargetKey: captured.startWaitForAuth[0].authTargetKey,
    missingKey: captured.startWaitForAuth[0].missingKey,
    authReason: "user_grant",
  });

  const afterUserGrant = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a", skillCommand: { skillName: "feishu-auth-basic" } });
  assert.equal(afterUserGrant?.block, true);
});

test("before_tool_call deduplicates a user-grant card after background app-scope poll sends one", async () => {
  const handlers = new Map();
  const scopes = ["aily:data_asset:upload_file", "base:block:create"];
  const captured = { sendAuthCard: [], checkUserGrant: [], startWaitForAuth: [] };
  let appScopeReady = false;
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-user-grant-cooldown.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-retry"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_retry_123"; },
    resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes }),
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => appScopeReady
      ? { ok: true, missing: [], granted: scopes, identity: "user" }
      : { ok: false, missing: ["aily:data_asset:upload_file"], granted: ["base:block:create"], identity: "user" },
    checkUserGrant: async (openId, requestedScopes, _ctx, options) => {
      captured.checkUserGrant.push({ openId, scopes: requestedScopes, options });
      return {
        ok: false,
        missing: requestedScopes,
        granted: [],
        reason: "user grant check did not include granted scope details",
      };
    },
    startLogin: async (_missing, _ctx, options) => ({ verificationUrl: "https://example.com/user-auth", userCode: "USER", deviceCode: "DEVICE", identity: options.identity }),
    getAuthedUser: async () => ({ openId: "ou_retry_123" }),
    sendAuthCard: async (payload) => { captured.sendAuthCard.push(payload); return { messageId: `msg_${captured.sendAuthCard.length}` }; },
    startWaitForAuth(payload) { captured.startWaitForAuth.push(payload); },
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const ctx = { channel: "feishu", accountId: "acc-a", skillCommand: { skillName: "feishu-auth-retry" } };
  const event = { toolName: "read", params: { path: basicSkillPath } };

  const first = await handlers.get("before_tool_call")(event, ctx);
  assert.equal(first?.block, true);
  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].authReason, "app_scope");
  assert.equal(captured.startWaitForAuth.length, 1);

  appScopeReady = true;
  await captured.startWaitForAuth[0].onAuthCardSent({
    authTargetKey: captured.startWaitForAuth[0].authTargetKey,
    missingKey: scopes.slice().sort().join("|"),
    authReason: "user_grant",
  });

  const second = await handlers.get("before_tool_call")(event, ctx);
  assert.equal(second?.block, true);
  assert.equal(captured.sendAuthCard.length, 1);
});
test("before_tool_call allows user identity skill when user grant scopes are verified", async () => {
  const handlers = new Map();
  const captured = { sendAuthCard: [], checkUserGrant: [], startWaitForAuth: [] };
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-user-grant-verified.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_user_verified_123"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async (scopes, _ctx, options) => ({ ok: true, missing: [], granted: scopes, identity: options.identity }),
    checkUserGrant: async (openId, scopes, _ctx, options) => {
      captured.checkUserGrant.push({ openId, scopes, options });
      return { ok: true, missing: [], granted: scopes, hasScopeDetails: true };
    },
    startLogin: async () => { throw new Error("verified user grant must not start login"); },
    getAuthedUser: async () => ({ openId: "ou_user_verified_123" }),
    sendAuthCard: async (payload) => { captured.sendAuthCard.push(payload); return { messageId: "msg_should_not_send" }; },
    startWaitForAuth(payload) { captured.startWaitForAuth.push(payload); },
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a", skillCommand: { skillName: "feishu-auth-basic" } });

  assert.equal(captured.checkUserGrant.length, 1);
  assert.equal(captured.checkUserGrant[0].openId, "ou_user_verified_123");
  assert.equal(captured.checkUserGrant[0].options?.requireScopeDetails, true);
  assert.equal(captured.sendAuthCard.length, 0);
  assert.equal(captured.startWaitForAuth.length, 0);
  assert.equal(result, undefined);
});

test("before_tool_call clears pending authorization and allows an authorized user grant", async () => {
  const handlers = new Map();
  const requiredScopes = ["search:message", "mail:user_mailbox.message:readonly"];
  const pendingNotices = new Map([["oauth-state-key", {
    authTargetKey: "oauth-state-key",
    skillName: "feishu-auth-basic",
    skillPath: basicSkillPath,
    accountId: "acc-a",
    openId: "ou_oauth_state_123",
    missing: requiredScopes,
    requiredScopes,
    missingKey: requiredScopes.slice().sort().join("|"),
    verificationUrl: "https://example.com/stale",
    status: "retrying",
    attemptCount: 1,
  }]]);
  const persisted = [];
  const captured = { startLogin: 0, cards: 0 };
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-authorized.json"; },
    readPendingAuthNoticeStore() { return pendingNotices; },
    writePendingAuthNoticeStore(_path, notices) { persisted.push([...notices.keys()]); },
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {},
    getCachedSenderId() { return "ou_oauth_state_123"; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: requiredScopes }),
    getSkillAuthCacheKey() { return "oauth-state-key"; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: true, missing: [], granted: requiredScopes }),
    checkUserGrant: async () => ({ ok: true, missing: [], granted: requiredScopes, oauthState: "authorized" }),
    getAuthedUser: async () => ({ openId: "ou_oauth_state_123" }),
    startLogin: async () => { captured.startLogin += 1; },
    sendAuthCard: async () => { captured.cards += 1; },
    startWaitForAuth() {},
  });
  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); },
  });

  const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a" });

  assert.equal(result, undefined);
  assert.equal(captured.startLogin, 0);
  assert.equal(captured.cards, 0);
  assert.deepEqual(persisted.at(-1), []);
});

test("pending user-grant retry reclassifies state and sends a fresh device-flow card to its chat recipient", async () => {
  const handlers = new Map();
  const requiredScopes = ["search:message", "mail:user_mailbox.message:readonly"];
  const pendingNotices = new Map([["oauth-retry-key", {
    authTargetKey: "oauth-retry-key",
    skillName: "feishu-auth-basic",
    skillPath: basicSkillPath,
    accountId: "acc-a",
    openId: "ou_retry_user",
    receiveId: "oc_retry_chat",
    receiveIdType: "chat_id",
    identity: "user",
    authReason: "user_grant",
    oauthState: "oauth_reauth_required",
    missing: ["search:message"],
    requiredScopes,
    missingKey: requiredScopes.slice().sort().join("|"),
    status: "retrying",
    attemptCount: 1,
    nextRetryAt: 0,
  }]]);
  const freshWaiter = { exited: true, exitCode: 1 };
  const captured = { loginScopes: [], cards: [], waiter: null };
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-fresh-retry.json"; },
    readPendingAuthNoticeStore() { return pendingNotices; }, writePendingAuthNoticeStore() {},
    canRetryPendingAuthNotice() { return true; },
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    getSkillAuthCacheKey() { return "oauth-retry-key"; },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {},
    getCachedSenderId() { return null; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: requiredScopes }),
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: true, missing: [], granted: requiredScopes }),
    checkUserGrant: async () => ({ ok: false, missing: ["mail:user_mailbox.message:readonly"], oauthState: "scope_missing" }),
    getAuthedUser: async () => null,
    startLogin: async (scopes) => {
      captured.loginScopes.push(scopes);
      return { verificationUrl: "https://example.com/fresh-device-flow", userCode: "FRESH", deviceCode: "FRESH_DEVICE", authWaiter: freshWaiter };
    },
    sendAuthCard: async (payload) => { captured.cards.push(payload); return { messageId: "msg_fresh_retry" }; },
    startWaitForAuth(payload) { captured.waiter = payload; },
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({});
  try {
    plugin.register({
      config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
      pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); },
    });
    await handlers.get("before_tool_call")(
      { toolName: "read", params: { path: basicSkillPath } },
      { channel: "feishu", accountId: "acc-a", channelId: "oc_retry_chat" },
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(captured.loginScopes, [requiredScopes]);
  assert.equal(captured.cards.length, 1);
  assert.equal(captured.cards[0].verificationUrl, "https://example.com/fresh-device-flow");
  assert.notEqual(captured.cards[0].verificationUrl, "https://example.com/stale");
  assert.equal(captured.cards[0].receiveId, "oc_retry_chat");
  assert.equal(captured.cards[0].receiveIdType, "chat_id");
  assert.deepEqual(captured.cards[0].missing, ["mail:user_mailbox.message:readonly"]);
  assert.deepEqual(captured.waiter.requiredScopes, requiredScopes);
  assert.equal(captured.waiter.authWaiter, freshWaiter);
});

test("concurrent pending retries share one in-flight login and card delivery", async () => {
  const handlers = new Map();
  let resolveLogin;
  const pendingNotices = new Map([["oauth-concurrent-key", {
    authTargetKey: "oauth-concurrent-key", skillName: "feishu-auth-basic", skillPath: basicSkillPath,
    accountId: "acc-a", openId: "ou_concurrent", requesterKey: "ou_concurrent", identity: "user", authReason: "user_grant",
    missing: ["search:message"], requiredScopes: ["search:message"], missingKey: "search:message",
    status: "retrying", attemptCount: 1, nextRetryAt: 0,
  }]]);
  const captured = { login: 0, cards: 0 };
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-concurrent-retry.json"; },
    readPendingAuthNoticeStore() { return pendingNotices; }, writePendingAuthNoticeStore() {}, canRetryPendingAuthNotice() { return true; },
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; }, buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); }, getSkillAuthCacheKey() { return "oauth-concurrent-key"; },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {}, getCachedSenderId() { return "ou_concurrent"; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: ["search:message"] }), ensureFeishuRuntimeHealth: async () => ({ ok: true }), checkScopes: async () => ({ ok: true, missing: [], granted: ["search:message"] }), checkUserGrant: async () => ({ ok: false, missing: ["search:message"], oauthState: "scope_missing" }), getAuthedUser: async () => ({ openId: "ou_concurrent" }),
    startLogin: async () => {
      captured.login += 1;
      return await new Promise((resolve) => { resolveLogin = resolve; });
    },
    sendAuthCard: async () => { captured.cards += 1; return { messageId: "msg_concurrent" }; }, startWaitForAuth() {},
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({});
  try {
    plugin.register({ config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } }, pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); } });
    const event = { toolName: "read", params: { path: basicSkillPath } };
    const ctx = { channel: "feishu", accountId: "acc-a" };
    const first = handlers.get("before_tool_call")(event, ctx);
    const second = handlers.get("before_tool_call")(event, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captured.login, 1);
    resolveLogin({ verificationUrl: "https://example.com/fresh", deviceCode: "fresh-device" });
    await Promise.all([first, second]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(captured.cards, 1);
});

test("pending OAuth notices are removed when reclassification reports an unavailable runtime", async () => {
  const handlers = new Map();
  const pendingNotices = new Map([["oauth-unavailable-key", {
    authTargetKey: "oauth-unavailable-key", skillName: "feishu-auth-basic", skillPath: basicSkillPath,
    accountId: "acc-a", openId: "ou_unavailable", identity: "user", authReason: "user_grant",
    missing: ["search:message"], requiredScopes: ["search:message"], missingKey: "search:message",
    status: "retrying", attemptCount: 1, nextRetryAt: 0,
  }]]);
  const persisted = [];
  const captured = { login: 0, cards: 0 };
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-unavailable-retry.json"; },
    readPendingAuthNoticeStore() { return pendingNotices; }, writePendingAuthNoticeStore(_path, notices) { persisted.push([...notices.keys()]); },
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; }, buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    getSkillAuthCacheKey() { return "oauth-unavailable-key"; }, cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {}, getCachedSenderId() { return "ou_unavailable"; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: ["search:message"] }), ensureFeishuRuntimeHealth: async () => ({ ok: true }), checkScopes: async () => ({ ok: true, missing: [], granted: ["search:message"] }),
    checkUserGrant: async () => ({ ok: false, missing: ["search:message"], oauthState: "oauth_runtime_unavailable", reason: "profile mismatch" }), getAuthedUser: async () => ({ openId: "ou_unavailable" }),
    startLogin: async () => { captured.login += 1; }, sendAuthCard: async () => { captured.cards += 1; }, startWaitForAuth() {},
  });
  plugin.register({ config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } }, pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); } });
  const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a" });
  assert.equal(result?.block, true);
  assert.equal(captured.login, 0);
  assert.equal(captured.cards, 0);
  assert.deepEqual(persisted.at(-1), []);
});

for (const scenario of [
  { oauthState: "oauth_reauth_required", missing: ["search:message"] },
  { oauthState: "scope_missing", missing: ["mail:user_mailbox.message:readonly"] },
]) {
  test(`before_tool_call starts user login with all required scopes for ${scenario.oauthState}`, async () => {
    const handlers = new Map();
    const requiredScopes = ["search:message", "mail:user_mailbox.message:readonly"];
    const captured = { loginScopes: null, card: null, waiter: null };
    const plugin = createPluginEntry({
      fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
      getPendingAuthNoticeStorePath() { return `/tmp/openclaw-skill-runtime-${scenario.oauthState}.json`; },
      readPendingAuthNoticeStore() { return new Map(); }, writePendingAuthNoticeStore() {},
      buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; },
      buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
      cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {},
      getCachedSenderId() { return "ou_oauth_state_123"; }, resolveWorkspaceDir() { return null; },
      readLarkAuth: () => ({ identity: "user", scopes: requiredScopes }),
      ensureFeishuRuntimeHealth: async () => ({ ok: true }),
      checkScopes: async () => ({ ok: true, missing: [], granted: requiredScopes }),
      checkUserGrant: async () => ({ ok: false, missing: scenario.missing, granted: [], oauthState: scenario.oauthState }),
      getAuthedUser: async () => ({ openId: "ou_oauth_state_123" }),
      startLogin: async (scopes) => {
        captured.loginScopes = scopes;
        return { verificationUrl: "https://example.com/user-auth", userCode: "USER", deviceCode: "DEVICE" };
      },
      sendAuthCard: async (payload) => { captured.card = payload; return { messageId: "msg_oauth_state" }; },
      startWaitForAuth(payload) { captured.waiter = payload; },
    });
    plugin.register({
      config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
      pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); },
    });

    const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a" });

    assert.deepEqual(captured.loginScopes, requiredScopes);
    assert.deepEqual(captured.card.missing, scenario.missing);
    assert.equal(captured.card.oauthState, scenario.oauthState);
    assert.equal(captured.waiter.oauthState, scenario.oauthState);
    assert.equal(result?.block, true);
  });
}

test("before_tool_call persists the OAuth reauthorization subtype when its card cannot be sent", async () => {
  const handlers = new Map();
  const requiredScopes = ["search:message", "mail:user_mailbox.message:readonly"];
  const persisted = [];
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    PENDING_AUTH_MAX_RETRIES: 1,
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-reauth-persist.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore(_path, notices) { persisted.push([...notices.values()]); },
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {},
    getCachedSenderId() { return "ou_oauth_state_123"; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: requiredScopes }),
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: true, missing: [], granted: requiredScopes }),
    checkUserGrant: async () => ({ ok: false, missing: ["search:message"], oauthState: "oauth_reauth_required" }),
    getAuthedUser: async () => ({ openId: "ou_oauth_state_123" }),
    startLogin: async () => ({ verificationUrl: "https://example.com/user-auth", userCode: "USER", deviceCode: "DEVICE" }),
    sendAuthCard: async () => ({ error: "send failed" }),
    startWaitForAuth() {},
  });
  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); },
  });

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({});
  try {
    await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a" });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(persisted.at(-1)[0].oauthState, "oauth_reauth_required");
  assert.deepEqual(persisted.at(-1)[0].requiredScopes, requiredScopes);
  assert.deepEqual(persisted.at(-1)[0].missing, ["search:message"]);
  assert.equal("verificationUrl" in persisted.at(-1)[0], false);
  assert.equal("deviceCode" in persisted.at(-1)[0], false);
});

test("before_tool_call blocks an unavailable OAuth runtime without starting login or an authorization card", async () => {
  const handlers = new Map();
  const requiredScopes = ["search:message"];
  const captured = { startLogin: 0, cards: 0, waiter: 0 };
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-unavailable.json"; },
    readPendingAuthNoticeStore() { return new Map(); }, writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {},
    getCachedSenderId() { return "ou_oauth_state_123"; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: requiredScopes }),
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: true, missing: [], granted: requiredScopes }),
    checkUserGrant: async () => ({ ok: false, missing: requiredScopes, oauthState: "oauth_runtime_unavailable", reason: "OAuth service unavailable" }),
    getAuthedUser: async () => ({ openId: "ou_oauth_state_123" }),
    startLogin: async () => { captured.startLogin += 1; },
    sendAuthCard: async () => { captured.cards += 1; },
    startWaitForAuth() { captured.waiter += 1; },
  });
  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); },
  });

  const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a" });

  assert.equal(result?.block, true);
  assert.match(result?.reason || "", /OAuth service unavailable/);
  assert.equal(captured.startLogin, 0);
  assert.equal(captured.cards, 0);
  assert.equal(captured.waiter, 0);
});
test("before_tool_call allows app identity skill when app identity scopes are open", async () => {
  const handlers = new Map();
  const captured = { sendAuthCard: [], checkScopes: [] };
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-app-identity.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_app_identity_123"; },
    resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "app", scopes: ["application:app_slash_command:read"] }),
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async (scopes, _ctx, options) => {
      captured.checkScopes.push({ scopes, identity: options.identity });
      return { ok: true, missing: [], granted: scopes, identity: options.identity };
    },
    checkUserGrant: async () => { throw new Error("app identity must not check user grant"); },
    sendAuthCard: async (payload) => { captured.sendAuthCard.push(payload); return { messageId: "msg_should_not_send" }; },
    startLogin: async () => { throw new Error("app identity open scopes must not start login"); },
    startWaitForAuth() {},
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const result = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, { channel: "feishu", accountId: "acc-a", skillCommand: { skillName: "feishu-auth-basic" } });

  assert.equal(captured.checkScopes.length, 1);
  assert.equal(captured.checkScopes[0].identity, "app");
  assert.equal(captured.sendAuthCard.length, 0);
  assert.equal(result, undefined);
});

test("before_tool_call blocks later untagged tool calls while authorization is pending", async () => {
  const handlers = new Map();
  let authWaiter = null;
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-pending-gate.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_pending_gate_123"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: false, missing: ["contact:user.base:readonly"], granted: [] }),
    startLogin: async () => ({ verificationUrl: "https://example.com/auth", deviceCode: "DEVICECODE" }),
    getAuthedUser: async () => ({ openId: "ou_pending_gate_123" }),
    sendAuthCard: async () => ({ messageId: "msg_pending_gate" }),
    startWaitForAuth(payload) { authWaiter = payload; },
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const ctx = { channel: "feishu", accountId: "acc-a", sessionId: "session-pending-gate", skillCommand: { skillName: "feishu-auth-basic" } };
  const authResult = await handlers.get("before_tool_call")({ toolName: "read", params: { path: basicSkillPath } }, ctx);
  const laterResult = await handlers.get("before_tool_call")(
    { toolName: "exec", params: { command: "echo must-not-run" } },
    { channel: "feishu", accountId: "acc-a", sessionId: "session-pending-gate" },
  );

  assert.equal(authResult?.block, true);
  assert.equal(laterResult?.block, true);
  assert.match(laterResult?.reason || "", /授权/);

  await authWaiter.onAuthorized({
    authTargetKey: authWaiter.authTargetKey,
    missingKey: authWaiter.missingKey,
    authReason: "user_grant",
  });
  const afterAuthorized = await handlers.get("before_tool_call")(
    { toolName: "exec", params: { command: "echo can-run" } },
    { channel: "feishu", accountId: "acc-a", sessionId: "session-pending-gate" },
  );
  assert.equal(afterAuthorized, undefined);
});

test("before_tool_call keeps concurrent users' authorization gates and retry notices isolated", async () => {
  const handlers = new Map();
  const persisted = [];
  let loginCalls = 0;
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-user-isolation.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore(_path, notices) { persisted.push([...notices.values()].map((notice) => notice.requesterKey)); },
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {},
    getCachedSenderId(ctx) { return ctx.senderId; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: ["scope:a"] }),
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({ ok: true, missing: [], granted: ["scope:a"] }),
    checkUserGrant: async () => ({ ok: false, missing: ["scope:a"], oauthState: "scope_missing" }),
    getAuthedUser: async (ctx) => ({ openId: ctx.senderId }),
    startLogin: async () => { loginCalls += 1; return { verificationUrl: "https://example.com/auth", deviceCode: "DEVICE" }; },
    sendAuthCard: async () => ({ error: "delivery unavailable" }),
    startWaitForAuth() {},
  });
  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); },
  });

  const read = { toolName: "read", params: { path: basicSkillPath } };
  const ctxA = { channel: "feishu", accountId: "acc-a", sessionId: "session-a", senderId: "ou_a", skillCommand: { skillName: "feishu-auth-basic" } };
  const ctxB = { channel: "feishu", accountId: "acc-a", sessionId: "session-b", senderId: "ou_b", skillCommand: { skillName: "feishu-auth-basic" } };
  const [resultA, resultB] = await Promise.all([
    handlers.get("before_tool_call")(read, ctxA),
    handlers.get("before_tool_call")(read, ctxB),
  ]);

  assert.equal(resultA?.block, true);
  assert.equal(resultB?.block, true);
  assert.equal(loginCalls, 2, "B must not inherit A's pending notice and skip its own authorization attempt");
  assert.deepEqual(persisted.at(-1), ["ou_b"], "the reused storage key is rebound to B rather than retaining A's notice");
  const laterB = await handlers.get("before_tool_call")({ toolName: "exec", params: { command: "echo blocked" } }, ctxB);
  assert.equal(laterB?.block, true, "a different user's pending authorization cannot clear B's gate");
});

test("authorization completion for user A cannot clear user B's execution gate", async () => {
  const handlers = new Map();
  const waiters = [];
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-user-gate-isolation.json"; }, readPendingAuthNoticeStore() { return new Map(); }, writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; }, buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); },
    cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {}, getCachedSenderId(ctx) { return ctx.senderId; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: ["scope:a"] }), ensureFeishuRuntimeHealth: async () => ({ ok: true }), checkScopes: async () => ({ ok: true, missing: [], granted: ["scope:a"] }),
    checkUserGrant: async () => ({ ok: false, missing: ["scope:a"], oauthState: "scope_missing" }), getAuthedUser: async (ctx) => ({ openId: ctx.senderId }),
    startLogin: async () => ({ verificationUrl: "https://example.com/auth", deviceCode: "DEVICE" }), sendAuthCard: async () => ({ messageId: "message" }), startWaitForAuth(payload) { waiters.push(payload); },
  });
  plugin.register({ config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } }, pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); } });
  const read = { toolName: "read", params: { path: basicSkillPath } };
  const ctxA = { channel: "feishu", accountId: "acc-a", sessionId: "gate-a", senderId: "ou_a", skillCommand: { skillName: "feishu-auth-basic" } };
  const ctxB = { channel: "feishu", accountId: "acc-a", sessionId: "gate-b", senderId: "ou_b", skillCommand: { skillName: "feishu-auth-basic" } };
  await handlers.get("before_tool_call")(read, ctxA);
  await handlers.get("before_tool_call")(read, ctxB);
  await waiters[0].onAuthorized({ authTargetKey: waiters[0].authTargetKey, missingKey: waiters[0].missingKey, authReason: "user_grant" });
  const laterB = await handlers.get("before_tool_call")({ toolName: "exec", params: { command: "echo blocked" } }, ctxB);
  assert.equal(laterB?.block, true);
});

test("app-scope to user-grant transition blocks diagnostically without another login when OAuth runtime is unavailable", async () => {
  const handlers = new Map();
  let appScopesReady = false;
  let loginCalls = 0;
  let cards = 0;
  const plugin = createPluginEntry({
    fileLog() {}, logCtxSnapshotOnce() {}, setApiConfigRef() {}, setPluginApiRef() {}, resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-oauth-transition.json"; }, readPendingAuthNoticeStore() { return new Map(); }, writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; }, getDefaultSkillRoots() { return []; }, buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-basic"]]); }, cachedAccountBySession: new Map(), cachedWorkspaceBySession: new Map(), cacheSenderId() {}, getCachedSenderId() { return "ou_transition"; }, resolveWorkspaceDir() { return null; },
    readLarkAuth: () => ({ identity: "user", scopes: ["scope:a"] }), ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => appScopesReady ? { ok: true, missing: [], granted: ["scope:a"] } : { ok: false, missing: ["scope:a"], granted: [] },
    checkUserGrant: async () => ({ ok: false, missing: ["scope:a"], oauthState: "oauth_runtime_unavailable", reason: "profile mismatch" }), getAuthedUser: async () => ({ openId: "ou_transition" }),
    startLogin: async () => { loginCalls += 1; return { verificationUrl: "https://example.com/auth", deviceCode: "DEVICE" }; }, sendAuthCard: async () => { cards += 1; return { messageId: "message" }; }, startWaitForAuth() {},
  });
  plugin.register({ config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } }, pluginConfig: { enabled: true, blockRead: true }, log: { info() {}, warn() {} }, on(name, handler) { handlers.set(name, handler); } });
  const event = { toolName: "read", params: { path: basicSkillPath } };
  const ctx = { channel: "feishu", accountId: "acc-a", senderId: "ou_transition", skillCommand: { skillName: "feishu-auth-basic" } };
  await handlers.get("before_tool_call")(event, ctx);
  appScopesReady = true;
  const result = await handlers.get("before_tool_call")(event, ctx);
  assert.equal(loginCalls, 1);
  assert.equal(cards, 1);
  assert.equal(result?.block, true);
  assert.match(result?.reason || "", /运行时当前不可用/);
});
