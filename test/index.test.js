import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPluginEntry } from "../index.js";
import { resolveSkillReadTarget } from "../utils.js";

const basicSkillPath = fileURLToPath(new URL("./fixtures/skills/feishu-auth-user-granted/SKILL.md", import.meta.url));
const userMissingSkillPath = fileURLToPath(new URL("./fixtures/skills/feishu-auth-user-missing/SKILL.md", import.meta.url));
const appMissingSkillPath = fileURLToPath(new URL("./fixtures/skills/feishu-auth-app-missing/SKILL.md", import.meta.url));

test("plugin schema uses PATH-discovered lark-cli without profile or installer settings", () => {
  const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const properties = manifest.configSchema.properties;

  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.ok(properties.larkCliPath);
  assert.equal("larkCliProfile" in properties, false);
  assert.equal("installLarkCliIfMissing" in properties, false);
});

test("plugin warns with the portable setup command when early skill access is not enabled", () => {
  const warnings = [];
  const plugin = createPluginEntry({
    fileLog() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
  });

  plugin.register({
    config: {
      plugins: {
        entries: {
          "openclaw-skill-runtime": { enabled: true },
        },
      },
    },
    pluginConfig: { enabled: true },
    log: {
      info() {},
      warn(message) { warnings.push(message); },
    },
    on() {},
  });

  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /openclaw config set plugins\.entries\.openclaw-skill-runtime\.hooks\.allowConversationAccess true/u,
  );
});

test("plugin does not warn when early skill access is enabled in the portable plugin configuration", () => {
  const warnings = [];
  const plugin = createPluginEntry({
    fileLog() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
  });

  plugin.register({
    config: {
      plugins: {
        entries: {
          "openclaw-skill-runtime": {
            enabled: true,
            hooks: { allowConversationAccess: true },
          },
        },
      },
    },
    pluginConfig: { enabled: true },
    log: {
      info() {},
      warn(message) { warnings.push(message); },
    },
    on() {},
  });

  assert.equal(warnings.length, 0);
});

test("before_agent_run blocks an explicit skill invocation before the model starts", async () => {
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
      return "/tmp/openclaw-skill-runtime-index-test-before-agent-run.json";
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
      return new Map([[basicSkillPath, "feishu-auth-user-granted"]]);
    },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId(ctx) {
      return ctx?.senderId || null;
    },
    resolveWorkspaceDir() {
      return null;
    },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: false,
      missing: ["base:app:create"],
      granted: [],
    }),
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["base:app:create"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
    }),
    startLogin: async () => ({
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async () => ({ openId: "ou_before_agent_run_123" }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_before_agent_run_123" };
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

  const event = {
    prompt: 'Use the "feishu-auth-user-granted" skill for this request.',
    messages: [],
    accountId: "acc-a",
    channelId: "oc_test_chat",
    senderId: "ou_before_agent_run_123",
  };
  const ignored = await handlers.get("before_agent_run")(event, {
    runId: "run-without-feishu-provider",
    sessionId: "session-without-feishu-provider",
    sessionKey: "session-key-without-feishu-provider",
    workspaceDir: "/tmp/workspace",
  });
  assert.equal(ignored, undefined);
  assert.equal(captured.sendAuthCard.length, 0);

  const result = await handlers.get("before_agent_run")(
    event,
    {
      runId: "run-before-agent-run",
      sessionId: "session-before-agent-run",
      sessionKey: "session-key-before-agent-run",
      workspaceDir: "/tmp/workspace",
      messageProvider: "feishu",
    },
  );

  assert.equal(result?.outcome, "block");
  assert.match(result?.message || "", /已发送授权卡片/);
  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-user-granted");
  assert.equal(captured.sendAuthCard[0].openId, "ou_before_agent_run_123");
  assert.equal(captured.startWaitForAuth.length, 1);
});

test("before_agent_run recognizes an explicit skill instruction after a runtime prompt prefix", async () => {
  const handlers = new Map();
  const captured = [];
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-prefix-test.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-user-granted"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId(ctx) { return ctx?.senderId || null; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["base:app:create"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
    }),
    startLogin: async () => ({ verificationUrl: "https://example.com/auth" }),
    getAuthedUser: async () => ({ openId: "ou_prompt_prefix_123" }),
    sendAuthCard: async (payload) => {
      captured.push(payload);
      return { messageId: "msg_prompt_prefix_123" };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: {
      channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } },
    },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const result = await handlers.get("before_agent_run")(
    {
      prompt: "Runtime context follows.\nUse the \"feishu-auth-user-granted\" skill for this request.\nContinue with the user request.",
      accountId: "acc-a",
      senderId: "ou_prompt_prefix_123",
    },
    {
      messageProvider: "feishu",
      sessionId: "session-prompt-prefix",
      sessionKey: "session-key-prompt-prefix",
      workspaceDir: "/tmp/workspace",
    },
  );

  assert.equal(result?.outcome, "block");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].skillName, "feishu-auth-user-granted");
});

test("before_agent_run blocks a cached bare skill command when ArkClaw omits the runtime instruction", async () => {
  const handlers = new Map();
  const captured = [];
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-cached-explicit-test.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-user-granted"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId(ctx) { return ctx?.senderId || "ou_cached_explicit_123"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["base:app:create"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
    }),
    startLogin: async () => ({ verificationUrl: "https://example.com/auth" }),
    getAuthedUser: async () => ({ openId: "ou_cached_explicit_123" }),
    sendAuthCard: async (payload) => {
      captured.push(payload);
      return { messageId: "msg_cached_explicit_123" };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: {
      channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } },
    },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  await handlers.get("message_received")(
    {
      // Moss sends the skill name itself, without a `/skill` prefix or a
      // Chinese imperative. Treat that as an explicit skill command too.
      text: "feishu-auth-user-granted",
      accountId: "acc-a",
      senderId: "ou_cached_explicit_123",
    },
    {
      channel: "feishu",
      messageProvider: "feishu",
      sessionId: "message-session-cached-explicit",
      sessionKey: "agent:main:main",
      channelId: "ou_cached_explicit_123",
      workspaceDir: "/tmp/workspace",
    },
  );

  const result = await handlers.get("before_agent_run")(
    { prompt: "ArkClaw runtime context without a skill instruction.", accountId: "acc-a" },
    {
      channel: "feishu",
      messageProvider: "feishu",
      sessionId: "run-session-cached-explicit",
      sessionKey: "agent:main:feishu:default:direct:ou_cached_explicit_123",
      channelId: "ou_cached_explicit_123",
      workspaceDir: "/tmp/workspace",
    },
  );

  assert.equal(result?.outcome, "block");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].skillName, "feishu-auth-user-granted");
});

test("before_tool_call blocks the first tool call when only before_prompt_build sees a bare skill command", async () => {
  const handlers = new Map();
  const captured = [];
  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() { return "/tmp/openclaw-skill-runtime-session-gate-test.json"; },
    readPendingAuthNoticeStore() { return new Map(); },
    writePendingAuthNoticeStore() {},
    buildSkillRootsCacheKey() { return "test-roots"; },
    getDefaultSkillRoots() { return []; },
    buildSkillMap() { return new Map([[basicSkillPath, "feishu-auth-user-granted"]]); },
    cachedAccountBySession: new Map(),
    cachedWorkspaceBySession: new Map(),
    cacheSenderId() {},
    getCachedSenderId() { return "ou_session_gate_123"; },
    resolveWorkspaceDir() { return null; },
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["base:app:create"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
    }),
    startLogin: async () => ({ verificationUrl: "https://example.com/auth" }),
    getAuthedUser: async () => ({ openId: "ou_session_gate_123" }),
    sendAuthCard: async (payload) => {
      captured.push(payload);
      return { messageId: "msg_session_gate_123" };
    },
    startWaitForAuth() {},
  });

  plugin.register({
    config: { channels: { feishu: { accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } } } } },
    pluginConfig: { enabled: true, blockRead: true },
    log: { info() {}, warn() {} },
    on(name, handler) { handlers.set(name, handler); },
  });

  const ctx = {
    channel: "feishu",
    messageProvider: "feishu",
    sessionId: "session-explicit-gate",
    sessionKey: "session-key-explicit-gate",
    workspaceDir: "/tmp/workspace",
  };
  await handlers.get("before_prompt_build")(
    { prompt: "feishu-auth-user-granted", accountId: "acc-a", senderId: "ou_session_gate_123" },
    ctx,
  );
  const toolResult = await handlers.get("before_tool_call")(
    { toolName: "feishu_bitable_app", params: {} },
    ctx,
  );

  assert.deepEqual(toolResult, {
    block: true,
    reason: "技能「feishu-auth-user-granted」需要飞书权限授权，已发送授权卡片，请先完成授权后重试。",
  });
  assert.equal(captured.length, 1);
});

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
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
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
      skillName: "feishu-auth-user-granted",
      missing: ["contact:user.base:readonly"],
      declaredScopes: [
        "base:app:create",
        "calendar:calendar.event:create",
        "approval:approval:readonly",
        "docs:document:import",
        "im:chat",
        "space:document:retrieve",
      ],
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
      openId: "ou_test_123",
      chatId: null,
      accountId: "acc-a",
      identity: "user",
      checkPhase: "app_scope",
      ctx: {
        channel: "feishu",
        sessionId: "session-a",
        sessionKey: "session-key-a",
        accountId: "acc-a",
        cwd: "/",
        senderId: "ou_test_123",
      },
    },
  ]);
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(captured.startWaitForAuth[0].skillName, "feishu-auth-user-granted");
  assert.equal(captured.startWaitForAuth[0].openId, "ou_test_123");
  assert.equal(result?.block, true);
  assert.match(result?.reason || "", /已发送授权卡片/);
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
      return new Map([[basicSkillPath, "feishu-auth-user-granted"]]);
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
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
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
        skillName: "feishu-auth-user-granted",
      },
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-user-granted");
  assert.equal(captured.sendAuthCard[0].openId, "ou_skill_command_123");
  assert.equal(captured.sendAuthCard[0].identity, "user");
  assert.equal(captured.sendAuthCard[0].checkPhase, "app_scope");
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
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
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
  assert.equal(captured.sendAuthCard[0].identity, "user");
  assert.equal(captured.sendAuthCard[0].checkPhase, "app_scope");
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
      return new Map([[basicSkillPath, "feishu-auth-user-granted"]]);
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
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["contact:user.base:readonly"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
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
          skillName: "feishu-auth-user-granted",
        },
      },
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-user-granted");
  assert.equal(captured.sendAuthCard[0].openId, "ou_trace_skill_command_123");
  assert.equal(captured.sendAuthCard[0].accountId, "acc-a");
  assert.equal(captured.sendAuthCard[0].identity, "user");
  assert.equal(captured.sendAuthCard[0].checkPhase, "app_scope");
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(result?.block, true);
});

test("before_tool_call intercepts missing app identity scopes and sends an auth card", async () => {
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
      return "/tmp/openclaw-skill-runtime-index-test-app-identity.json";
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
    getCachedSenderId() {
      return "ou_app_identity_123";
    },
    resolveWorkspaceDir() {
      return null;
    },
    resolveSkillReadTarget,
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: false,
      missing: ["calendar:room:readonly"],
      granted: [],
    }),
    checkApplicationAuthorization: async () => ({
      ok: false,
      missing: ["calendar:room:readonly"],
      incompatible: [],
      granted: [],
      catalogUnavailable: false,
    }),
    checkUserAuthorizationByLarkCli: async () => {
      throw new Error("app identity must not start a user lark-cli check");
    },
    startLogin: async () => ({
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
    }),
    getAuthedUser: async () => ({ openId: "ou_app_identity_123" }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_app_identity_123" };
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
      toolName: "read",
      params: {
        path: appMissingSkillPath,
      },
    },
    {
      channel: "feishu",
      sessionId: "session-app-identity",
      sessionKey: "session-key-app-identity",
      accountId: "acc-a",
      cwd: "/",
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-app-missing");
  assert.deepEqual(captured.sendAuthCard[0].missing, ["calendar:room:readonly"]);
  assert.equal(captured.sendAuthCard[0].identity, "app");
  assert.equal(captured.sendAuthCard[0].checkPhase, "app_scope");
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(result?.block, true);
});

test("before_tool_call intercepts missing user grant even when app scopes are already granted", async () => {
  const handlers = new Map();
  const captured = {
    sendAuthCard: [],
    startWaitForAuth: [],
    larkCliChecks: [],
    startLogin: [],
  };

  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() {
      return "/tmp/openclaw-skill-runtime-index-test-user-grant.json";
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
    getCachedSenderId() {
      return "ou_user_grant_123";
    },
    resolveWorkspaceDir() {
      return null;
    },
    resolveSkillReadTarget,
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: true,
      missing: [],
      granted: ["base:block:create", "base:block:update"],
    }),
    checkApplicationAuthorization: async () => ({
      ok: true,
      missing: [],
      incompatible: [],
      granted: ["base:block:create", "base:block:update"],
      catalogUnavailable: false,
    }),
    checkUserAuthorization: async () => {
      throw new Error("default user grants must use lark-cli");
    },
    checkUserAuthorizationByLarkCli: async (scopes, ctx, options) => {
      captured.larkCliChecks.push({ scopes, ctx, options });
      return {
        ok: false,
        missing: ["base:block:create", "base:block:update"],
        granted: [],
      };
    },
    startLogin: async (missing, ctx, options) => {
      captured.startLogin.push({ missing, ctx, options });
      return {
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
      };
    },
    getAuthedUser: async () => ({ openId: "ou_user_grant_123" }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_user_grant_123" };
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
      toolName: "read",
      params: {
        path: userMissingSkillPath,
      },
    },
    {
      channel: "feishu",
      sessionId: "session-user-grant",
      sessionKey: "session-key-user-grant",
      accountId: "acc-a",
      cwd: "/",
    },
  );

  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu-auth-user-missing");
  assert.deepEqual(captured.sendAuthCard[0].missing, ["base:block:create", "base:block:update"]);
  assert.equal(captured.sendAuthCard[0].identity, "user");
  assert.equal(captured.sendAuthCard[0].checkPhase, "user_grant");
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(captured.larkCliChecks.length, 1);
  assert.equal(captured.startLogin[0].options.userAuthProvider, "lark-cli");
  assert.equal(result?.block, true);
});

test("before_tool_call can authorize configured Feishu tools without a skill context", async () => {
  const handlers = new Map();
  const captured = {
    sendAuthCard: [],
    startLogin: [],
  };

  const plugin = createPluginEntry({
    fileLog() {},
    logCtxSnapshotOnce() {},
    setApiConfigRef() {},
    setPluginApiRef() {},
    resetRuntimeCaches() {},
    getPendingAuthNoticeStorePath() {
      return "/tmp/openclaw-skill-runtime-index-test-tool-auth.json";
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
    getCachedSenderId() {
      return "ou_tool_auth_123";
    },
    resolveWorkspaceDir() {
      return null;
    },
    resolveSkillReadTarget,
    ensureFeishuRuntimeHealth: async () => ({ ok: true }),
    checkScopes: async () => ({
      ok: true,
      missing: [],
      granted: ["base:app:create"],
    }),
    checkApplicationAuthorization: async () => ({
      ok: true,
      missing: [],
      incompatible: [],
      granted: ["base:app:create"],
      catalogUnavailable: false,
    }),
    checkUserAuthorization: async () => ({
      ok: false,
      missing: ["base:app:create"],
      granted: [],
      reason: "user_token_missing",
    }),
    startLogin: async (missing, ctx, options) => {
      captured.startLogin.push({ missing, options });
      return {
        verificationUrl: "https://example.com/user-oauth",
        userCode: null,
        deviceCode: null,
      };
    },
    getAuthedUser: async () => ({ openId: "ou_tool_auth_123" }),
    sendAuthCard: async (payload) => {
      captured.sendAuthCard.push(payload);
      return { messageId: "msg_tool_auth_123" };
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
      userAuthProvider: "context",
      userOAuthRedirectUri: "https://example.com/oauth/callback",
      toolAuth: {
        feishu_bitable_app: {
          identity: "user",
          scopes: ["base:app:create"],
        },
      },
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
      toolName: "feishu_bitable_app",
      params: { action: "create", name: "lark-test" },
    },
    {
      channel: "feishu",
      sessionId: "session-tool-auth",
      sessionKey: "session-key-tool-auth",
      accountId: "acc-a",
    },
  );

  assert.equal(result?.block, true);
  assert.equal(captured.sendAuthCard.length, 1);
  assert.equal(captured.sendAuthCard[0].skillName, "feishu_bitable_app");
  assert.deepEqual(captured.sendAuthCard[0].missing, ["base:app:create"]);
  assert.equal(captured.sendAuthCard[0].identity, "user");
  assert.equal(captured.sendAuthCard[0].checkPhase, "user_grant");
  assert.equal(captured.startLogin.length, 1);
  assert.equal(captured.startLogin[0].options.checkPhase, "user_grant");
  assert.equal(captured.startLogin[0].options.userAuthProvider, "context");
  assert.equal(captured.startLogin[0].options.redirectUri, "https://example.com/oauth/callback");
});
