import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSkillRootsCacheKey,
  cacheSenderId,
  fileLog,
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
  resolveAuthCardRecipient,
  updateInteractiveCard,
} from "../utils.js";

test("getDefaultSkillRoots includes agent and OpenClaw global skill roots", () => {
  assert.deepEqual(getDefaultSkillRoots({}), [
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".openclaw", "workspace", "skills"),
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
      abs: resolve(skillPath),
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

test("resolveAuthCardRecipient prefers a nested Feishu open_id", () => {
  assert.deepEqual(
    resolveAuthCardRecipient({ sender: { sender_id: { open_id: "ou_nested_user" } } }),
    { receiveId: "ou_nested_user", receiveIdType: "open_id" },
  );
});

test("resolveAuthCardRecipient falls back to a Feishu chat_id", () => {
  assert.deepEqual(
    resolveAuthCardRecipient({ channelId: "oc_group_chat" }),
    { receiveId: "oc_group_chat", receiveIdType: "chat_id" },
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

test("sendAuthCard renders distinct user-grant guidance for reauthorization and missing scopes", async () => {
  const cards = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        cards.push(JSON.parse(payload.content));
        return { data: { message_id: `msg_${cards.length}` } };
      },
    },
  });

  try {
    for (const oauthState of ["oauth_reauth_required", "scope_missing"]) {
      await sendAuthCard({
        skillName: "feishu-auth-basic",
        missing: ["contact:user.base:readonly"],
        verificationUrl: "https://example.com/auth",
        userCode: "USERCODE",
        openId: "ou_plugin_123",
        accountId: "acc-a",
        identity: "user",
        authReason: "user_grant",
        oauthState,
      });
    }
  } finally {
    setPluginApiRef(null);
  }

  const reauthorizationText = cards[0].body.elements[0].content;
  const missingScopesText = cards[1].body.elements[0].content;
  assert.match(reauthorizationText, /重新授权/);
  assert.match(missingScopesText, /当前授权缺少所需权限/);
  assert.notEqual(missingScopesText, reauthorizationText);
});

test("sendAuthCard sends to a chat when no user open_id is available", async () => {
  const calls = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        calls.push(payload);
        return { data: { message_id: "msg_chat_123" } };
      },
    },
  });

  const result = await sendAuthCard({
    skillName: "feishu-auth-basic",
    missing: ["contact:user.base:readonly"],
    verificationUrl: "https://example.com/auth",
    userCode: "USERCODE",
    receiveId: "oc_group_chat",
    receiveIdType: "chat_id",
    accountId: "acc-a",
  });

  assert.equal(result.messageId, "msg_chat_123");
  assert.equal(calls[0].receive_id, "oc_group_chat");
  assert.equal(calls[0].receive_id_type, "chat_id");
  setPluginApiRef(null);
});

test("updateInteractiveCard does not accept an error response merely because it has data", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        calls.push(payload);
        return { code: 99991663, msg: "permission denied", data: { message_id: "msg_123" } };
      },
    },
  });
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: { "acc-a": { appId: "cli_test", appSecret: "secret_test" } },
      },
    },
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 99991663, msg: "permission denied", data: {} }), { status: 200 });

  try {
    const result = await updateInteractiveCard("msg_123", { schema: "2.0" }, { accountId: "acc-a" });
    assert.equal(result.messageId, undefined);
    assert.match(result.error || "", /permission denied/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
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

test("checkUserGrant verifies matching user grant through lark-cli auth status", async () => {
  const calls = [];
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.LARK_PROFILE_NAME;
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    calls.push(args);
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: {
          user: {
            status: "not-ready",
            available: true,
            verified: true,
            openId: "ou_requester",
            scope: "scope:a scope:b offline_access",
          },
        },
      }),
      stderr: "",
      code: 0,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, true);
    assert.equal(result.source, "lark-cli-status");
    assert.equal(result.oauthState, "authorized");
    assert.deepEqual(result.granted, ["scope:a", "scope:b"]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(calls, [["--version"], ["auth", "status", "--verify"]]);
    assert.equal(calls.some((args) => args.includes("check") || args.includes("--json")), false);
  } finally {
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});

test("checkUserGrant resolves the matching lark-cli profile by OpenClaw appId before checking OAuth", async () => {
  const calls = [];
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  const oldLarkProfile = process.env.LARK_PROFILE_NAME;
  delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  delete process.env.LARK_PROFILE_NAME;
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_a9476381fcfbdcdd", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    if (args[0] === "auth" && args[1] === "status") {
      return { stdout: JSON.stringify({ ok: false, error: { type: "config", message: "not configured" } }), stderr: "", code: 1, ok: false };
    }
    if (args[0] === "profile") {
      return {
        stdout: JSON.stringify([
          { name: "other-profile", appId: "cli_other" },
          { name: "profile-for-openclaw", appId: "cli_a9476381fcfbdcdd" },
        ]),
        stderr: "",
        code: 0,
        ok: true,
      };
    }
    return {
      stdout: JSON.stringify({
        appId: "cli_a9476381fcfbdcdd",
        identities: {
          user: {
            status: "verify_failed",
            available: false,
            verified: false,
            openId: "ou_requester",
          },
        },
        message: "server rejected token: [20005] token revoked",
      }),
      stderr: "",
      code: 1,
      ok: false,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a"], { accountId: "acc-a" });
    assert.equal(result.oauthState, "oauth_reauth_required");
    const repeated = await checkUserGrant("ou_requester", ["scope:a"], { accountId: "acc-a" });
    assert.equal(repeated.oauthState, "oauth_reauth_required");
    assert.deepEqual(calls, [
      ["--version"],
      ["auth", "status", "--verify"],
      ["profile", "list"],
      ["--profile", "profile-for-openclaw", "auth", "status", "--verify"],
      ["--version"],
      ["--profile", "profile-for-openclaw", "auth", "status", "--verify"],
    ]);
  } finally {
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("checkUserGrant reports scope_missing from a verified lark-cli status", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: {
          user: {
            available: true,
            verified: true,
            openId: "ou_requester",
            scope: "scope:a",
          },
        },
      }),
      stderr: "",
      code: 0,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.equal(result.source, "lark-cli-status");
    assert.equal(result.oauthState, "scope_missing");
    assert.deepEqual(result.granted, ["scope:a"]);
    assert.deepEqual(result.missing, ["scope:b"]);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("checkUserGrant falls back to lark-cli when a runtime checker lacks server attestation", async () => {
  const calls = [];
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant() {
        return { ok: true, granted: ["scope:a", "scope:b"] };
      },
    },
  });
  setLarkCliCommandRunnerForTest(async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: { user: { available: true, verified: true, openId: "ou_requester", scope: "scope:a scope:b" } },
      }),
      stderr: "",
      code: 0,
      ok: true,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.source, "lark-cli-status");
    assert.deepEqual(calls, [["--version"], ["auth", "status", "--verify"]]);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("checkUserGrant falls back to lark-cli when a server-attested checker response has mismatched identity", async () => {
  const calls = [];
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant() {
        return {
          serverVerified: true,
          appId: "other_app",
          openId: "ou_requester",
          granted: ["scope:a", "scope:b"],
        };
      },
    },
  });
  setLarkCliCommandRunnerForTest(async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: { user: { available: true, verified: true, openId: "ou_requester", scope: "scope:a scope:b" } },
      }),
      stderr: "",
      code: 0,
      ok: true,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.source, "lark-cli-status");
    assert.deepEqual(calls, [["--version"], ["auth", "status", "--verify"]]);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("checkUserGrant accepts a matching server-attested runtime checker grant without lark-cli", async () => {
  let cliCalled = false;
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant() {
        return {
          serverVerified: true,
          appId: "cli_app",
          openId: "ou_requester",
          granted: ["scope:a", "scope:b"],
        };
      },
    },
  });
  setLarkCliCommandRunnerForTest(async () => {
    cliCalled = true;
    throw new Error("trusted runtime checker must not invoke lark-cli");
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, true);
    assert.equal(result.source, "runtime-checker");
    assert.equal(result.oauthState, "authorized");
    assert.deepEqual(result.granted, ["scope:a", "scope:b"]);
    assert.deepEqual(result.missing, []);
    assert.equal(cliCalled, false);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("checkUserGrant returns normalized missing scopes from a matching server-attested runtime checker", async () => {
  let cliCalled = false;
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant() {
        return {
          serverVerified: true,
          appId: "cli_app",
          openId: "ou_requester",
          granted: ["scope:a"],
        };
      },
    },
  });
  setLarkCliCommandRunnerForTest(async () => {
    cliCalled = true;
    throw new Error("trusted runtime checker must not invoke lark-cli");
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.equal(result.source, "runtime-checker");
    assert.equal(result.oauthState, "scope_missing");
    assert.deepEqual(result.granted, ["scope:a"]);
    assert.deepEqual(result.missing, ["scope:b"]);
    assert.equal(cliCalled, false);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("checkUserGrant does not trust an otherwise verified status after a failed lark-cli command", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: {
          user: {
            available: true,
            verified: true,
            openId: "ou_requester",
            scope: "scope:a scope:b",
          },
        },
      }),
      stderr: "status command failed",
      code: 1,
      ok: false,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.equal(result.oauthState, "oauth_runtime_unavailable");
    assert.deepEqual(result.missing, ["scope:a", "scope:b"]);
    assert.match(result.reason || "", /status command failed/);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});

test("checkUserGrant requires OAuth reauthorization for a matching rejected access token, even after a nonzero status exit", async () => {
  const calls = [];
  const oldProfile = process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
  process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = "profile-x";
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    calls.push(args);
    if (args.at(-1) === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: {
          user: {
            status: "verify_failed",
            available: false,
            verified: false,
            openId: "ou_requester",
          },
        },
        message: "[20005] invalid access token",
      }),
      stderr: "",
      code: 1,
      ok: false,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a", "scope:b"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.equal(result.oauthState, "oauth_reauth_required");
    assert.deepEqual(result.missing, ["scope:a", "scope:b"]);
    assert.deepEqual(calls, [
      ["--profile", "profile-x", "--version"],
      ["--profile", "profile-x", "auth", "status", "--verify"],
    ]);
  } finally {
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});

test("checkUserGrant requires OAuth reauthorization for a matching explicit 20005 rejection without an English token message", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: {
          user: {
            status: "verify_failed",
            available: false,
            verified: false,
            openId: "ou_requester",
          },
        },
        message: "server rejected token: [20005] token revoked",
      }),
      stderr: "",
      code: 1,
      ok: false,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.equal(result.oauthState, "oauth_reauth_required");
    assert.deepEqual(result.missing, ["scope:a"]);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});

test("checkUserGrant requires OAuth reauthorization for a matching missing user identity", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setPluginApiRef(null);
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return {
      stdout: JSON.stringify({
        appId: "cli_app",
        identities: {
          user: { status: "missing", available: false, openId: "ou_requester" },
        },
      }),
      stderr: "",
      code: 0,
      ok: true,
    };
  });

  try {
    const result = await checkUserGrant("ou_requester", ["scope:a"], { accountId: "acc-a" });
    assert.equal(result.ok, false);
    assert.equal(result.oauthState, "oauth_reauth_required");
    assert.deepEqual(result.missing, ["scope:a"]);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
  }
});

test("checkUserGrant rejects untrusted lark-cli status payloads as runtime unavailable", async () => {
  const cases = [
    {
      name: "top-level app mismatch",
      payload: { appId: "other_app", identities: { user: { status: "missing", available: false, openId: "ou_requester" } } },
    },
    {
      name: "existing user mismatch",
      payload: { appId: "cli_app", identities: { user: { status: "missing", available: false, openId: "ou_other" } } },
    },
    {
      name: "missing requester",
      openId: "",
      payload: { appId: "cli_app", identities: { user: { status: "missing", available: false, openId: "ou_requester" } } },
    },
    {
      name: "configuration error",
      payload: { ok: false, error: { type: "config" } },
    },
    {
      name: "malformed output",
      stdout: "not-json",
    },
    {
      name: "unknown verify failure",
      payload: { appId: "cli_app", identities: { user: { status: "verify_failed", available: false, verified: false, openId: "ou_requester" } } },
    },
  ];

  for (const scenario of cases) {
    setApiConfigRef({
      channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
    });
    setPluginApiRef(null);
    setLarkCliCommandRunnerForTest(async (args) => {
      if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
      return { stdout: scenario.stdout || JSON.stringify(scenario.payload), stderr: "status diagnostic", code: 1, ok: false };
    });
    try {
      const result = await checkUserGrant(scenario.openId === undefined ? "ou_requester" : scenario.openId, ["scope:a"], { accountId: "acc-a" });
      assert.equal(result.ok, false, scenario.name);
      assert.equal(result.oauthState, "oauth_runtime_unavailable", scenario.name);
      assert.deepEqual(result.missing, ["scope:a"], scenario.name);
      assert.ok(result.reason, `${scenario.name} preserves the diagnostic reason`);
    } finally {
      setLarkCliCommandRunnerForTest(null);
      setPluginApiRef(null);
    }
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
    assert.equal(result.oauthState, "oauth_runtime_unavailable");
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
  resetRuntimeCaches();
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": { appId: "cli_app", appSecret: "secret_123" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(async (args) => {
    commandCalls.push(args);
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "profile" && args[1] === "list") {
      return { stdout: "[]", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "config" && args[1] === "bind") {
      return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0, ok: true };
    }
    return {
      stdout: JSON.stringify({ verification_url: "https://example.com/user-login", device_code: "device-123", expires_in: 600, interval: 5 }),
      stderr: "",
      code: 0,
    };
  });
  setLarkCliDeviceWaitSpawnerForTest((args) => {
    spawnCalls.push(args);
    return waiter;
  });
  const waiter = { started: true, pid: 1234, exited: false };

  try {
    const result = await startLogin(["scope:a"], {}, { identity: "user", authReason: "user_grant" });
    assert.equal(result.verificationUrl, "https://example.com/user-login");
    assert.equal(result.deviceCode, "device-123");
    assert.equal(result.provider, "lark-cli");
    assert.equal(result.authWaiter, waiter);
    assert.deepEqual(commandCalls, [
      ["--version"],
      ["profile", "list"],
      ["config", "bind", "--source", "openclaw", "--app-id", "cli_app", "--identity", "user-default"],
      ["auth", "login", "--scope", "scope:a", "--no-wait", "--json"],
    ]);
    assert.deepEqual(spawnCalls, [["auth", "login", "--device-code", "device-123"]]);
  } finally {
    if (oldProfile === undefined) delete process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE;
    else process.env.OPENCLAW_SKILL_RUNTIME_LARK_PROFILE = oldProfile;
    if (oldLarkProfile === undefined) delete process.env.LARK_PROFILE_NAME;
    else process.env.LARK_PROFILE_NAME = oldLarkProfile;
    setLarkCliCommandRunnerForTest(null);
    setLarkCliDeviceWaitSpawnerForTest(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
  }
});

test("startWaitForAuth cancels a spawned device waiter after authorization completes", async () => {
  let cancelled = 0;
  const waiter = { started: true, exited: false, cancel() { cancelled += 1; } };
  resetRuntimeCaches();
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant() {
        return { serverVerified: true, appId: "cli_app", openId: "ou_cancel_waiter", ok: true, grantedScopes: ["scope:a"] };
      },
    },
  });
  setApiConfigRef({ channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret" } } } } });
  setLarkCliDeviceWaitSpawnerForTest(() => waiter);
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "profile" && args[1] === "list") {
      return { stdout: "[]", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "config" && args[1] === "bind") {
      return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0, ok: true };
    }
    return { stdout: JSON.stringify({ verification_url: "https://example.com/login", device_code: "device-cancel" }), stderr: "", code: 0, ok: true };
  });
  try {
    const login = await startLogin(["scope:a"], { accountId: "acc-a" }, { identity: "user", authReason: "user_grant" });
    startWaitForAuth({ authTargetKey: "cancel-waiter", skillName: "feishu-auth-basic", deviceCode: login.deviceCode, openId: "ou_cancel_waiter", scopes: ["scope:a"], requiredScopes: ["scope:a"], authReason: "user_grant", authWaiter: login.authWaiter, ctx: { accountId: "acc-a" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, 1);
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setLarkCliDeviceWaitSpawnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
  }
});

test("fileLog redacts OAuth credentials and recipient identities", () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    fileLog("authUrl=https://example.com/oauth?code=very-secret userCode=USER_SECRET deviceCode=DEVICE_SECRET receiveId=ou_sensitive_user");
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /very-secret|USER_SECRET|DEVICE_SECRET|ou_sensitive_user/);
  assert.match(lines[0], /<redacted>/);
});

test("fileLog redacts JSON OAuth secrets in stringified error contexts", () => {
  const lines = [];
  const originalLog = console.log;
  const secrets = ["DEVICE_JSON_SECRET", "USER_JSON_SECRET", "TOKEN_JSON_SECRET", "https://example.com/verify?code=URL_JSON_SECRET", "ou_json_recipient"];
  console.log = (line) => lines.push(line);
  try {
    fileLog(`OAuth check failed: ${JSON.stringify({
      deviceCode: secrets[0],
      userCode: secrets[1],
      access_token: secrets[2],
      verification_url: secrets[3],
      receiveId: secrets[4],
    })}`);
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  for (const secret of secrets) assert.doesNotMatch(lines[0], new RegExp(secret.replace(/[?]/g, "\\?")));
  assert.match(lines[0], /<redacted>/);
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
    if (args[0] === "profile" && args[1] === "list") {
      return { stdout: "[]", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "config" && args[1] === "bind") {
      return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0, ok: true };
    }
    if (args[0] === "auth" && args[1] === "status") {
      authCheckCount += 1;
      return {
        stdout: JSON.stringify({
          appId: "cli_no_device",
          identities: {
            user: {
              status: "ready",
              available: true,
              verified: true,
              openId: "ou_test",
              scope: authCheckCount === 1 ? "" : "scope:a",
            },
          },
        }),
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
  const userLoginScopes = [];
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "profile" && args[1] === "list") {
      return { stdout: "[]", stderr: "", code: 0, ok: true };
    }
    if (args[0] === "config" && args[1] === "bind") {
      return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0, ok: true };
    }
    if (args[0] === "auth" && args[1] === "status") {
      authCheckCount += 1;
      return {
        stdout: JSON.stringify({
          appId: "cli_test",
          identities: {
            user: {
              status: "ready",
              available: true,
              verified: true,
              openId: "ou_test",
              scope: authCheckCount === 1 ? "scope:a" : "scope:a scope:b",
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "auth" && args[1] === "login") {
      userLoginScopes.push(args[3]);
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
    assert.deepEqual(userLoginScopes, ["scope:a scope:b"]);
    assert.equal(sentCards.length, 3);
    assert.equal(sentCards[0].action, "update");
    assert.equal(sentCards[0].message_id, "msg_app_scope");
    assert.equal(JSON.parse(sentCards[0].content).header.template, "green");

    assert.equal(sentCards[1].action, "send");
    const userGrantCard = JSON.parse(sentCards[1].content);
    const userGrantButton = userGrantCard.body.elements.find((element) => element?.tag === "button");
    assert.match(userGrantButton?.behaviors?.[0]?.default_url || "", /example\.com%2Fuser-login/);
    assert.match(userGrantCard.body.elements[1].elements[0].content, /scope:b/);
    assert.doesNotMatch(userGrantCard.body.elements[1].elements[0].content, /scope:a/);
    assert.match(userGrantCard.body.elements[0].content, /当前授权缺少所需权限/);

    assert.equal(sentCards[2].action, "update");
    assert.equal(sentCards[2].message_id, "msg_2");
    assert.equal(JSON.parse(sentCards[2].content).header.template, "green");

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

test("startWaitForAuth ignores an old poll after the same auth target is replaced", async () => {
  let resolveFirst;
  let resolveSecond;
  const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
  const secondResult = new Promise((resolve) => { resolveSecond = resolve; });
  let checks = 0;
  const authorized = [];

  setPluginApiRef({
    tools: {
      openclaw_lark_check_user_grant() {
        checks += 1;
        return checks === 1 ? firstResult : secondResult;
      },
    },
  });
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });

  try {
    const common = {
      authTargetKey: "replaced-poll",
      skillName: "feishu-auth-basic",
      deviceCode: "device-code",
      missingKey: "scope:a",
      openId: "ou_replaced_poll",
      scopes: ["scope:a"],
      authReason: "user_grant",
      ctx: { accountId: "acc-a" },
    };
    startWaitForAuth({ ...common, onAuthorized: () => authorized.push("first") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    startWaitForAuth({ ...common, onAuthorized: () => authorized.push("second") });
    await new Promise((resolve) => setTimeout(resolve, 0));

    resolveSecond({ serverVerified: true, appId: "cli_app", openId: "ou_replaced_poll", ok: true, grantedScopes: ["scope:a"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFirst({ serverVerified: true, appId: "cli_app", openId: "ou_replaced_poll", ok: true, grantedScopes: ["scope:a"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(authorized, ["second"]);
  } finally {
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("startWaitForAuth updates the user-grant card when the OAuth waiter exits without authorization", async () => {
  const updates = [];
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant() {
        return {
          serverVerified: true,
          appId: "cli_app",
          openId: "ou_cancelled_user",
          ok: false,
          missingScopes: ["scope:a"],
        };
      },
      async feishu_im_user_message(payload) {
        updates.push(payload);
        return { success: true };
      },
    },
  });
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });

  try {
    startWaitForAuth({
      authTargetKey: "cancelled-user-grant",
      skillName: "feishu-auth-basic",
      deviceCode: "device-code",
      missingKey: "scope:a",
      openId: "ou_cancelled_user",
      scopes: ["scope:a"],
      identity: "user",
      authReason: "user_grant",
      ctx: { accountId: "acc-a" },
      authMessageId: "msg_cancelled",
      authWaiter: { exited: true, exitCode: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, "update");
    const card = JSON.parse(updates[0].content);
    assert.match(card.header.title.content, /未完成/);
  } finally {
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("startWaitForAuth verifies every required user scope before marking an OAuth grant complete", async () => {
  const authorized = [];
  const checkedScopes = [];
  setPluginApiRef({
    tools: {
      async openclaw_lark_check_user_grant({ scopes }) {
        checkedScopes.push(scopes);
        return {
          serverVerified: true,
          appId: "cli_app",
          openId: "ou_full_scope_user",
          ok: scopes.includes("scope:a"),
          missingScopes: scopes.includes("scope:a") ? ["scope:a"] : [],
        };
      },
    },
  });
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });

  try {
    startWaitForAuth({
      authTargetKey: "full-scope-user-grant",
      skillName: "feishu-auth-basic",
      deviceCode: "device-code",
      missingKey: "scope:a|scope:b",
      openId: "ou_full_scope_user",
      scopes: ["scope:b"],
      requiredScopes: ["scope:a", "scope:b"],
      identity: "user",
      authReason: "user_grant",
      ctx: { accountId: "acc-a" },
      authWaiter: { exited: true, exitCode: 1 },
      onAuthorized: () => authorized.push("authorized"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(checkedScopes, [["scope:a", "scope:b"]]);
    assert.deepEqual(authorized, []);
  } finally {
    setPluginApiRef(null);
    setApiConfigRef(null);
  }
});

test("startWaitForAuth keeps an unavailable OAuth runtime blocked when its waiter exits", async () => {
  const updates = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        updates.push(payload);
        return { success: true };
      },
    },
  });
  setApiConfigRef({
    channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret_123" } } } },
  });
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return { stdout: JSON.stringify({ ok: false, error: { type: "config" } }), stderr: "runtime unavailable", code: 1, ok: false };
  });

  try {
    startWaitForAuth({
      authTargetKey: "unavailable-user-grant",
      skillName: "feishu-auth-basic",
      deviceCode: "device-code",
      missingKey: "scope:a",
      openId: "ou_unavailable_user",
      scopes: ["scope:a"],
      identity: "user",
      authReason: "user_grant",
      ctx: { accountId: "acc-a" },
      authMessageId: "msg_unavailable",
      authWaiter: { exited: true, exitCode: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(updates.length, 1);
    const card = JSON.parse(updates[0].content);
    assert.match(card.header.title.content, /运行时不可用/);
    assert.doesNotMatch(card.header.title.content, /未完成/);
  } finally {
    setPluginApiRef(null);
    setApiConfigRef(null);
    setLarkCliCommandRunnerForTest(null);
  }
});

test("startWaitForAuth updates an app-scope card when authorization times out", async () => {
  const updates = [];
  const originalDateNow = Date.now;
  let nowCalls = 0;
  Date.now = () => (nowCalls++ === 0 ? 0 : 180001);
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        updates.push(payload);
        return { success: true };
      },
    },
  });

  try {
    startWaitForAuth({
      authTargetKey: "timeout-app-scope",
      skillName: "feishu-auth-basic",
      deviceCode: "device-code",
      missingKey: "scope:a",
      openId: "ou_timeout_user",
      scopes: ["scope:a"],
      identity: "user",
      authReason: "app_scope",
      ctx: { accountId: "acc-a" },
      authMessageId: "msg_timeout",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, "update");
    const card = JSON.parse(updates[0].content);
    assert.match(card.header.title.content, /应用权限开通超时/);
  } finally {
    Date.now = originalDateNow;
    setPluginApiRef(null);
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

test("checkUserGrant treats a matching app's missing user status as reauthorization when requester is known", async () => {
  setApiConfigRef({ channels: { feishu: { accounts: { "acc-a": { appId: "cli_app", appSecret: "secret" } } } } });
  setLarkCliCommandRunnerForTest(async (args) => {
    if (args[0] === "--version") return { stdout: "lark-cli 1.0.0", stderr: "", code: 0, ok: true };
    return {
      stdout: JSON.stringify({ appId: "cli_app", identities: { user: { status: "missing", available: false } } }),
      stderr: "", code: 0, ok: true,
    };
  });
  try {
    const result = await checkUserGrant("ou_requester", ["scope:a"], { accountId: "acc-a" });
    assert.equal(result.oauthState, "oauth_reauth_required");
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setApiConfigRef(null);
  }
});
