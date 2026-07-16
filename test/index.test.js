import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createPluginEntry } from "../index.js";
import { resolveSkillReadTarget } from "../utils.js";

const basicSkillPath = fileURLToPath(new URL("./fixtures/skills/feishu-auth-user-granted/SKILL.md", import.meta.url));

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
      skillName: "feishu-auth-user-granted",
      missing: ["contact:user.base:readonly"],
      verificationUrl: "https://example.com/auth",
      userCode: "USERCODE",
      deviceCode: "DEVICECODE",
      openId: "ou_test_123",
      accountId: "acc-a",
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
  assert.equal(captured.startWaitForAuth.length, 1);
  assert.equal(result?.block, true);
});
