import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
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

test("getDefaultSkillRoots includes agent and OpenClaw global skill roots", () => {
  assert.deepEqual(getDefaultSkillRoots({}), [
    `${homedir()}/.agents/skills`,
    `${homedir()}/.openclaw/workspace/skills`,
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
  assert.deepEqual(
    resolveSkillReadTarget("/root/.openclaw/workspace/skills/feishu-auth-basic/SKILL.md"),
    {
      abs: "/root/.openclaw/workspace/skills/feishu-auth-basic/SKILL.md",
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
  setLarkCliCommandRunnerForTest(async (args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({ ok: false, granted: ["scope:a"], missing: ["scope:b"] }),
      stderr: "",
      code: 0,
    };
  });

  try {
    const result = await checkUserGrant("ou_test", ["scope:a", "scope:b"], {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.granted, ["scope:a"]);
    assert.deepEqual(result.missing, ["scope:b"]);
    assert.deepEqual(calls, [["--version"], ["auth", "check", "--json", "--scope", "scope:a scope:b"]]);
  } finally {
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
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    return {
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      code: 0,
      ok: true,
    };
  });

  try {
    const result = await checkUserGrant("ou_test", ["scope:a", "scope:b"], {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["scope:a", "scope:b"]);
    assert.match(result.reason || "", /scope details/);
  } finally {
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
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    return {
      stdout: JSON.stringify({ ok: true, missing: [] }),
      stderr: "",
      code: 0,
      ok: true,
    };
  });

  try {
    const result = await checkUserGrant("ou_test", ["scope:a", "scope:b"], {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["scope:a", "scope:b"]);
  } finally {
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
  setLarkCliCommandRunnerForTest(async (args) => {
    commandCalls.push(args);
    return {
      stdout: JSON.stringify({ verification_url: "https://example.com/user-login", device_code: "device-123", expires_in: 600, interval: 5 }),
      stderr: "",
      code: 0,
    };
  });
  setLarkCliDeviceWaitSpawnerForTest((args) => {
    spawnCalls.push(args);
    return { started: true, pid: 1234 };
  });

  try {
    const result = await startLogin(["scope:a"], {}, { identity: "user", authReason: "user_grant" });
    assert.equal(result.verificationUrl, "https://example.com/user-login");
    assert.equal(result.deviceCode, "device-123");
    assert.equal(result.provider, "lark-cli");
    assert.deepEqual(commandCalls, [["--version"], ["auth", "login", "--scope", "scope:a", "--no-wait", "--json"]]);
    assert.deepEqual(spawnCalls, [["auth", "login", "--device-code", "device-123"]]);
  } finally {
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

  let authCheckCount = 0;
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "auth" && args[1] === "check") {
      authCheckCount += 1;
      return {
        stdout: JSON.stringify(
          { ok: true, missing: [] },
        ),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "auth" && args[1] === "login") {
      return {
        stdout: JSON.stringify({
          verification_url: "https://example.com/user-login",
          device_code: "device-user-grant",
          expires_in: 600,
          interval: 5,
        }),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`unexpected lark-cli args ${args.join(" ")}`);
  });
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

    assert.equal(authCheckCount, 2);
    assert.equal(sentCards[0].action, "update");
    assert.equal(sentCards[0].message_id, "msg_app_scope");
    assert.equal(sentCards[1].action, "send");
    const userGrantCard = JSON.parse(sentCards[1].content);
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

  let authCheckCount = 0;
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "auth" && args[1] === "check") {
      authCheckCount += 1;
      return {
        stdout: JSON.stringify(
          { ok: true, missing: [] },
        ),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "auth" && args[1] === "login") {
      return {
        stdout: JSON.stringify({
          verification_url: "https://example.com/user-login",
          device_code: "device-user-grant",
          expires_in: 600,
          interval: 5,
        }),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`unexpected lark-cli args ${args.join(" ")}`);
  });
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

    assert.equal(authCheckCount, 2);
    assert.equal(sentCards.length, 4);
    assert.equal(sentCards[0].action, "update");
    assert.equal(sentCards[0].message_id, "msg_app_scope");
    assert.equal(JSON.parse(sentCards[0].content).header.template, "green");

    assert.equal(sentCards[1].action, "send");
    const userGrantCard = JSON.parse(sentCards[1].content);
    const userGrantButton = userGrantCard.body.elements.find((element) => element?.tag === "button");
    assert.match(userGrantButton?.behaviors?.[0]?.default_url || "", /example\.com%2Fuser-login/);
    assert.match(userGrantCard.body.elements[1].elements[0].content, /scope:a/);
    assert.match(userGrantCard.body.elements[1].elements[0].content, /scope:b/);

    assert.equal(sentCards[2].action, "update");
    assert.equal(sentCards[2].message_id, "msg_2");
    assert.equal(JSON.parse(sentCards[2].content).header.template, "green");

    assert.equal(sentCards[3].action, "send");
    assert.match(JSON.parse(sentCards[3].content).header.title.content, /授权完成/);
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
