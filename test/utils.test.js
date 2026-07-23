import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import {
  buildSkillRootsCacheKey,
  cacheSenderId,
  checkUserAuthorization,
  checkUserAuthorizationByLarkCli,
  getCachedSenderId,
  getDefaultSkillRoots,
  getAccountCredentials,
  inferSenderIdFromCtx,
  getSkillAuthCacheKey,
  checkApplicationAuthorization,
  resolveSkillReadTarget,
  sendAuthCard,
  startLogin,
  setApiConfigRef,
  setPluginApiRef,
  selectAuthedUserProfile,
} from "../utils.js";

test("startLogin falls back to scope grant when context user authorization has no redirect URI", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": {
            appId: "cli_target",
            appSecret: "secret_123",
          },
        },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://accounts.feishu.cn");
    assert.equal(url.pathname, "/oauth/v1/app/registration");
    return new Response(JSON.stringify({
      verification_uri: "https://accounts.feishu.cn/verify",
      device_code: "device-code",
    }), { status: 200 });
  };

  try {
    const result = await startLogin(["base:app:create"], { accountId: "acc-a" }, {
      identity: "user",
      checkPhase: "user_grant",
      userAuthProvider: "context",
    });

    assert.equal(new URL(result.verificationUrl).origin, "https://accounts.feishu.cn");
    assert.equal(result.deviceCode, "device-code");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("checkUserAuthorization can read matching profile scopes for the current app", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": {
            appId: "cli_target",
            appSecret: "secret_123",
          },
        },
      },
    },
  });

  const result = await checkUserAuthorization(
    ["base:block:create", "base:block:update"],
    {
      accountId: "acc-a",
      authProfiles: [
        {
          app_id: "cli_other",
          user_open_id: "ou_other",
          scopes: ["im:chat"],
        },
        {
          app_id: "cli_target",
          user_open_id: "ou_target",
          scopes: ["base:block:create", "base:block:update"],
        },
      ],
    },
  );

  assert.deepEqual(result, {
    ok: true,
    missing: [],
    granted: ["base:block:create", "base:block:update"],
    source: "ctx.authProfiles",
  });
});

test("checkUserAuthorization treats expired user tokens as missing authorization", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": {
            appId: "cli_target",
            appSecret: "secret_123",
          },
        },
      },
    },
  });

  const result = await checkUserAuthorization(
    ["base:app:create"],
    {
      accountId: "acc-a",
      authProfiles: [
        {
          app_id: "cli_target",
          user_open_id: "ou_target",
          user_access_token: "u-token-expired",
          expires_at: Date.now() - 1000,
          scopes: ["base:app:create"],
        },
      ],
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["base:app:create"]);
  assert.equal(result.source, "ctx.authProfiles");
  assert.equal(result.reason, "user_token_expired");
});

test("checkApplicationAuthorization enforces token_types by identity", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          "acc-a": {
            appId: "cli_target",
            appSecret: "secret_123",
          },
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url);
    if (url.pathname.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-token", expire: 7200 }), { status: 200 });
    }
    if (url.pathname.endsWith("/open-apis/application/v6/applications/cli_target")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          app: {
            scopes: [
              { scope: "s.userOnly", token_types: ["user"], level: 1 },
              { scope: "s.tenantOnly", token_types: ["tenant"], level: 1 },
              { scope: "s.both", token_types: ["user", "tenant"], level: 1 },
            ],
          },
        },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  };

  try {
    const ctx = { accountId: "acc-a" };
    assert.deepEqual(
      await checkApplicationAuthorization(["s.userOnly", "s.tenantOnly", "s.missing"], "user", ctx),
      {
        ok: false,
        missing: ["s.missing"],
        incompatible: ["s.tenantOnly"],
        granted: ["s.userOnly"],
        catalogUnavailable: false,
      },
    );
    assert.deepEqual(
      await checkApplicationAuthorization(["s.both", "s.userOnly"], "app", ctx),
      {
        ok: false,
        missing: [],
        incompatible: ["s.userOnly"],
        granted: ["s.both"],
        catalogUnavailable: false,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkUserAuthorizationByLarkCli uses adapter check results", async () => {
  const adapter = {
    capabilityCheck: async () => ({ ok: true, version: "v0" }),
    bind: async () => ({ ok: true }),
    check: async ({ scopes }) => ({ ok: false, missing: scopes.slice(1) }),
  };
  const res = await checkUserAuthorizationByLarkCli(["s.a", "s.b"], { accountId: "acc-a" }, { adapter });
  assert.deepEqual(res, { ok: false, missing: ["s.b"], source: "lark-cli" });
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
    resolveSkillReadTarget("/root/.openclaw/workspace/skills/feishu-auth-user-granted/SKILL.md"),
    {
      abs: "/root/.openclaw/workspace/skills/feishu-auth-user-granted/SKILL.md",
      skillName: "feishu-auth-user-granted",
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
    skillName: "feishu-auth-user-granted",
    missing: ["contact:user.base:readonly"],
    verificationUrl: "https://example.com/auth",
    userCode: "USERCODE",
    openId: "ou_plugin_123",
    accountId: "acc-a",
    ctx: { accountId: "acc-a" },
  });

  assert.equal(result.messageId, "msg_plugin_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receive_id, "ou_plugin_123");
  assert.equal(calls[0].msg_type, "interactive");
  setPluginApiRef(null);
});

test("sendAuthCard labels app-scope and user-grant authorization separately", async () => {
  const calls = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        calls.push(payload);
        return { data: { message_id: `msg_${calls.length}` } };
      },
    },
  });

  const common = {
    skillName: "feishu-auth-user-granted",
    missing: ["base:app:create"],
    verificationUrl: "https://example.com/auth",
    userCode: "USERCODE",
    openId: "ou_plugin_123",
    accountId: "acc-a",
    ctx: { accountId: "acc-a" },
  };

  await sendAuthCard({ ...common, identity: "app", checkPhase: "app_scope" });
  await sendAuthCard({ ...common, identity: "user", checkPhase: "app_scope" });
  await sendAuthCard({ ...common, identity: "user", checkPhase: "user_grant" });

  const cards = calls.map((call) => JSON.parse(call.content));
  assert.equal(cards[0].header.template, "blue");
  assert.equal(cards[0].header.title.content, "飞书应用身份 API 权限开通提醒");
  assert.equal(cards[1].header.template, "purple");
  assert.equal(cards[1].header.title.content, "飞书用户身份 API 权限开通提醒");
  assert.equal(cards[2].header.template, "orange");
  assert.equal(cards[2].header.title.content, "飞书当前用户 OAuth 授权提醒");

  assert.deepEqual(cards.map((card) => card.body.elements.map((element) => element.tag)), [
    ["markdown", "collapsible_panel", "hr", "button", "markdown"],
    ["markdown", "collapsible_panel", "hr", "button", "markdown"],
    ["markdown", "collapsible_panel", "hr", "button", "markdown"],
  ]);
  assert.deepEqual(cards.map((card) => card.header.subtitle.content), [
    "技能 “feishu-auth-user-granted” 需要完成飞书权限处理",
    "技能 “feishu-auth-user-granted” 需要完成飞书权限处理",
    "技能 “feishu-auth-user-granted” 需要完成飞书权限处理",
  ]);
  assert.deepEqual(cards.map((card) => card.body.elements[1].header.title.content), [
    "**🔍 查看 Skill 声明权限（1 项）**",
    "**🔍 查看 Skill 声明权限（1 项）**",
    "**🔍 查看 Skill 声明权限（1 项）**",
  ]);
  assert.match(cards[0].body.elements[0].content, /授权对象：\*\*应用身份 API 权限\*\*/);
  assert.match(cards[1].body.elements[0].content, /授权对象：\*\*用户身份 API 权限\*\*/);
  assert.match(cards[2].body.elements[0].content, /授权对象：\*\*当前用户授权\*\*/);
  assert.deepEqual(cards.map((card) => card.body.elements[4].content), [
    "<font color='grey'>📝 点击「前往开通」后，按飞书页面提示完成操作，再回到当前会话重试。</font>",
    "<font color='grey'>📝 点击「前往开通」后，按飞书页面提示完成操作，再回到当前会话重试。</font>",
    "<font color='grey'>📝 点击「前往授权」后，按飞书页面提示完成操作，再回到当前会话重试。</font>",
  ]);

  setPluginApiRef(null);
});

test("sendAuthCard shows every scope declared by the Skill while retaining the current phase count", async () => {
  const calls = [];
  setPluginApiRef({
    tools: {
      async feishu_im_user_message(payload) {
        calls.push(payload);
        return { data: { message_id: "msg_declared_scopes_123" } };
      },
    },
  });

  await sendAuthCard({
    skillName: "feishu-auth-user-granted",
    // The app-side phase currently needs only these two permissions.
    missing: ["base:app:create", "calendar:calendar.event:create"],
    // The skill itself declares seven permissions, all of which must be visible.
    declaredScopes: [
      "search:message",
      "base:app:create",
      "calendar:calendar.event:create",
      "approval:approval:readonly",
      "docs:document:import",
      "im:chat",
      "space:document:retrieve",
    ],
    verificationUrl: "https://example.com/auth",
    openId: "ou_plugin_123",
    accountId: "acc-a",
    identity: "user",
    checkPhase: "app_scope",
    ctx: { accountId: "acc-a" },
  });

  const card = JSON.parse(calls[0].content);
  assert.match(card.body.elements[0].content, /共声明 \*\*7\*\* 项飞书权限/);
  assert.match(card.body.elements[0].content, /当前需要先处理 \*\*2\*\* 项/);
  assert.equal(card.body.elements[1].header.title.content, "**🔍 查看 Skill 声明权限（7 项）**");
  assert.match(card.body.elements[1].elements[0].content, /• `search:message`/);
  assert.match(card.body.elements[1].elements[0].content, /• `space:document:retrieve`/);

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
