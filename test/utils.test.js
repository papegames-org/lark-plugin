import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSkillRootsCacheKey,
  cacheSenderId,
  checkUserGrant,
  getCachedSenderId,
  getDefaultSkillRoots,
  getAccountCredentials,
  inferSenderIdFromCtx,
  getSkillAuthCacheKey,
  resolveSkillReadTarget,
  sendAuthCard,
  startLogin,
  startWaitForAuth,
  resetRuntimeCaches,
  setApiConfigRef,
  setPluginApiRef,
  setLarkCliCommandRunnerForTest,
  setLarkCliDeviceWaitSpawnerForTest,
  selectAuthedUserProfile,
  normalizeAppScopeEntries,
  normalizeAuthIdentity,
} from "../utils.js";
import { createLarkCliCommandRunner, okLarkCliResult } from "./helpers/lark-cli-mock.js";
import { normalizePathForAssert } from "./helpers/test-env.js";

test("getDefaultSkillRoots includes agent and OpenClaw global skill roots", () => {
  assert.deepEqual(getDefaultSkillRoots({}).map(normalizePathForAssert), [
    normalizePathForAssert(join(homedir(), ".agents", "skills")),
    normalizePathForAssert(join(homedir(), ".openclaw", "workspace", "skills")),
  ]);
});

test("buildSkillRootsCacheKey is stable across root ordering", () => {
  const left = buildSkillRootsCacheKey(["~/alpha", "/tmp/bravo"]);
  const right = buildSkillRootsCacheKey(["/tmp/bravo", "~/alpha"]);
  assert.equal(left, right);
});

test("selectAuthedUserProfile prefers appId match before fallback", () => {
  const selected = selectAuthedUserProfile([
    { user_open_id: "ou-fallback", app_id: "cli-app-a" },
    { user_open_id: "ou-target", app_id: "cli-app-b" },
  ], { appId: "cli-app-b" });

  assert.equal(selected?.openId, "ou-target");
});

test("selectAuthedUserProfile falls back to accountId match", () => {
  const selected = selectAuthedUserProfile([
    { userOpenId: "ou-a", accountId: "acc-a" },
    { userOpenId: "ou-b", accountId: "acc-b" },
  ], { accountId: "acc-b" });

  assert.equal(selected?.openId, "ou-b");
});

test("getSkillAuthCacheKey isolates same skill path by account", () => {
  const skillPath = "/tmp/skill-a/SKILL.md";
  assert.notEqual(
    getSkillAuthCacheKey(skillPath, { accountId: "acc-a" }),
    getSkillAuthCacheKey(skillPath, { accountId: "acc-b" }),
  );
});

test("resolveSkillReadTarget recognizes direct OpenClaw skill reads without workspaceDir", () => {
  const skillPath = "/root/.openclaw/workspace/skills/feishu-auth-basic/SKILL.md";
  assert.deepEqual(
    resolveSkillReadTarget(skillPath),
    {
      abs: normalizePathForAssert(resolve(skillPath)),
      skillName: "feishu-auth-basic",
    },
  );
});

test("inferSenderIdFromCtx falls back to channelId when it already carries a Feishu open_id", () => {
  assert.equal(
    inferSenderIdFromCtx({ channelId: "ou_4fc048c59c4820feda9d591cd213b480" }),
    "ou_4fc048c59c4820feda9d591cd213b480",
  );
});

test("cacheSenderId restores sender identity across hooks", () => {
  cacheSenderId({ sessionId: "session-a" }, "ou_123");
  assert.equal(getCachedSenderId({ sessionId: "session-a" }), "ou_123");
});

test("getCachedSenderId can reuse Feishu channelId as a direct sender fallback", () => {
  assert.equal(
    getCachedSenderId({ channelId: "ou_4fc048c59c4820feda9d591cd213b480" }),
    "ou_4fc048c59c4820feda9d591cd213b480",
  );
});

test("sendAuthCard prefers plugin feishu message tool when available", async () => {
  const calls = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        calls.push(payload);
        return { data: { message_id: "msg_plugin_123" } };
      },
    },
  });

  const result = await sendAuthCard({
    skillName: "feishu-auth-basic",
    missing: ["contact:user.base:readonly"],
    verificationUrl: "https://example.com/auth",
    userCode: "USERCODE",
    openId: "ou_plugin_123",
    accountId: "acc-a",
  });

  assert.equal(result.messageId, "msg_plugin_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receive_id, "ou_plugin_123");
  assert.equal(calls[0].msg_type, "interactive");
  setPluginApiRef(null);
});

test("getAccountCredentials resolves app credentials from account config", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": {
            appId: "cli_123",
            appSecret: "secret_123",
          },
        },
      },
    },
  });

  await assert.doesNotReject(async () => {
    assert.deepEqual(await getAccountCredentials({ accountId: "acc-a" }), {
      accountId: "acc-a",
      appId: "cli_123",
      appSecret: "secret_123",
      brand: "feishu",
      domain: null,
    });
  });
});

test("getAccountCredentials ignores legacy unknown accountId and falls back to the single configured account", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": {
            appId: "cli_123",
            appSecret: "secret_123",
          },
        },
      },
    },
  });

  await assert.doesNotReject(async () => {
    assert.deepEqual(await getAccountCredentials({ accountId: "unknown" }), {
      accountId: "acc-a",
      appId: "cli_123",
      appSecret: "secret_123",
      brand: "feishu",
      domain: null,
    });
  });
});

test("normalizeAppScopeEntries preserves identity for duplicate scope strings", () => {
  const entries = normalizeAppScopeEntries([
    { scope: "application:app_slash_command:read", identity_type: "app" },
    { scope: "application:app_slash_command:read", identity_type: "user" },
  ]);

  assert.deepEqual(entries.map((entry) => `${entry.identity}::${entry.scope}`), [
    "app::application:app_slash_command:read",
    "user::application:app_slash_command:read",
  ]);
  assert.equal(normalizeAuthIdentity("application"), "app");
  assert.equal(normalizeAuthIdentity("user"), "user");
});

test("checkUserGrant falls back to lark-cli auth check when runtime checker is unavailable", async () => {
  const calls = [];
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.LARK_PROFILE_NAME;
  setPluginApiRef(null);
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_123", appSecret: "secret_123" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    calls,
    appId: "cli_123",
    openId: "ou_test",
    grantedScopes: ["scope:a"],
  }));

  try {
    const result = await checkUserGrant("ou_test", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.granted, ["scope:a"]);
    assert.deepEqual(result.missing, ["scope:b"]);
    assert.ok(calls.some((args) => args[0] === "auth" && args[1] === "status" && args[2] === "--verify"));
  } finally {
    setApiConfigRef(null);
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});


test("checkUserGrant does not trust ok=true without scope details", async () => {
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.LARK_PROFILE_NAME;
  setPluginApiRef(null);
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_123", appSecret: "secret_123" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    appId: "cli_123",
    openId: "ou_test",
    statusPayload: { ok: true },
    userVerified: false,
  }));

  try {
    const result = await checkUserGrant("ou_test", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["scope:a", "scope:b"]);
    assert.equal(result.unavailable, true);
  } finally {
    setApiConfigRef(null);
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});

test("checkUserGrant does not treat empty missing as enough before user auth starts", async () => {
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.LARK_PROFILE_NAME;
  setPluginApiRef(null);
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_123", appSecret: "secret_123" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    appId: "cli_123",
    openId: "ou_test",
    statusPayload: {
      appId: "cli_123",
      identities: {
        user: {
          openId: "ou_test",
          available: true,
          verified: true,
          scope: [],
          scopes: [],
        },
      },
    },
  }));

  try {
    const result = await checkUserGrant("ou_test", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["scope:a", "scope:b"]);
  } finally {
    setApiConfigRef(null);
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});
test("startLogin uses lark-cli device flow for user grants", async () => {
  const commandCalls = [];
  const spawnCalls = [];
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.LARK_PROFILE_NAME;
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: { appId: "cli_test", appSecret: "secret_test" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    calls: commandCalls,
    appId: "cli_test",
    deviceCode: "device-123",
    verificationUrl: "https://example.com/user-login",
  }));
  setLarkCliDeviceWaitSpawnerForTest((args) => {
    spawnCalls.push(args);
    return { started: true, pid: 1234 };
  });

  try {
    const result = await startLogin(["scope:a"], { accountId: "default" }, { identity: "user", authReason: "user_grant" });
    assert.equal(result.verificationUrl, "https://example.com/user-login");
    assert.equal(result.deviceCode, "device-123");
    assert.equal(result.provider, "lark-cli");
    assert.ok(commandCalls.some((args) => args.includes("auth") && args.includes("login")));
    assert.ok(spawnCalls.some((args) => args.includes("--device-code") && args.includes("device-123")));
  } finally {
    setApiConfigRef(null);
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setLarkCliDeviceWaitSpawnerForTest(null);
  }
});

test("startWaitForAuth polls app-scope completion without app device code", async () => {
  const oldFetch = globalThis.fetch;
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.LARK_PROFILE_NAME;
  resetRuntimeCaches();
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: {
            appId: "cli_no_device",
            appSecret: "secret_test",
          },
        },
      },
    },
  });

  const sentCards = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        sentCards.push(payload);
        return { data: { message_id: `msg_${sentCards.length}` } };
      },
    },
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("tenant_access_token")) {
      return {
        ok: true,
        async json() {
          return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
        },
      };
    }
    if (href.includes("/open-apis/application/v6/applications/cli_no_device")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              app: {
                scopes: [{ scope: "scope:a", identity_type: "user" }],
              },
            },
          };
        },
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  let statusVerifyCount = 0;
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    appId: "cli_no_device",
    openId: "ou_test",
    grantedScopes: [],
    onAuthStatusVerify: () => {
      statusVerifyCount += 1;
      return okLarkCliResult(JSON.stringify({
        appId: "cli_no_device",
        identities: {
          user: {
            openId: "ou_test",
            open_id: "ou_test",
            available: false,
            verified: false,
            status: "missing",
          },
        },
      }));
    },
  }));
  setLarkCliDeviceWaitSpawnerForTest(() => ({ started: true, pid: 4321 }));

  try {
    startWaitForAuth({
      authTargetKey: "test-no-app-device",
      skillName: "feishu-auth-no-device",
      deviceCode: null,
      missingKey: "scope:a",
      openId: "ou_test",
      scopes: ["scope:a"],
      identity: "user",
      authReason: "app_scope",
      ctx: { accountId: "default" },
      authMessageId: "msg_app_scope",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(statusVerifyCount >= 1);
    const userGrantUpdate = sentCards.find((card) => card.action === "update" && card.message_id === "msg_app_scope");
    assert.ok(userGrantUpdate);
    const userGrantCard = JSON.parse(userGrantUpdate.content);
    const userGrantButton = userGrantCard.body.elements.find((element) => element?.tag === "button");
    assert.match(userGrantButton?.behaviors?.[0]?.default_url || "", /example\.com%2Fuser-login/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setLarkCliDeviceWaitSpawnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
  }
});
test("startWaitForAuth chains app-scope success into user-grant auth for user identity skills", async () => {
  const oldFetch = globalThis.fetch;
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.LARK_PROFILE_NAME;
  resetRuntimeCaches();
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: {
            appId: "cli_test",
            appSecret: "secret_test",
          },
        },
      },
    },
  });

  const sentCards = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        sentCards.push(payload);
        return { data: { message_id: `msg_${sentCards.length}` } };
      },
    },
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("tenant_access_token")) {
      return {
        ok: true,
        async json() {
          return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
        },
      };
    }
    if (href.includes("/open-apis/application/v6/applications/cli_test")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              app: {
                scopes: [
                  { scope: "scope:a", identity_type: "user" },
                  { scope: "scope:b", identity_type: "user" },
                ],
              },
            },
          };
        },
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  let statusVerifyCount = 0;
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    appId: "cli_test",
    openId: "ou_test",
    grantedScopes: [],
    onAuthStatusVerify: () => {
      statusVerifyCount += 1;
      return okLarkCliResult(JSON.stringify({
        appId: "cli_test",
        identities: {
          user: {
            openId: "ou_test",
            open_id: "ou_test",
            available: false,
            verified: false,
            status: "missing",
          },
        },
      }));
    },
  }));
  setLarkCliDeviceWaitSpawnerForTest(() => ({ started: true, pid: 4321 }));

  try {
    startWaitForAuth({
      authTargetKey: "test-two-phase",
      skillName: "feishu-auth-retry",
      deviceCode: "app-device-code",
      missingKey: "scope:b",
      openId: "ou_test",
      scopes: ["scope:b"],
      requiredScopes: ["scope:a", "scope:b"],
      identity: "user",
      authReason: "app_scope",
      ctx: { accountId: "default" },
      authMessageId: "msg_app_scope",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(statusVerifyCount >= 1);
    const userGrantUpdate = sentCards.find((card) => card.action === "update" && card.message_id === "msg_app_scope");
    assert.ok(userGrantUpdate);
    const userGrantCard = JSON.parse(userGrantUpdate.content);
    const userGrantButton = userGrantCard.body.elements.find((element) => element?.tag === "button");
    assert.match(userGrantButton?.behaviors?.[0]?.default_url || "", /example\.com%2Fuser-login/);
    assert.match(userGrantCard.body.elements[1].elements[0].content, /scope:a/);
    assert.match(userGrantCard.body.elements[1].elements[0].content, /scope:b/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setLarkCliDeviceWaitSpawnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
  }
});
test("startLogin reports lark-cli as a hard precondition for user grants", async () => {
  setLarkCliCommandRunnerForTest(async () => ({
    stdout: "",
    stderr: "",
    code: "ENOENT",
    ok: false,
    error: { code: "ENOENT", message: "spawn lark-cli ENOENT" },
  }));

  try {
    const result = await startLogin(["scope:a"], {}, { identity: "user", authReason: "user_grant" });
    assert.equal(result.precondition, "lark-cli");
    assert.match(result.error, /lark-cli not found in gateway PATH/);
    assert.match(result.error, /config bind --source openclaw --identity user-default/);
  } finally {
    setLarkCliCommandRunnerForTest(null);
  }
});
