import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSkillRootsCacheKey,
  cacheSenderId,
  checkUserGrant,
  collectLarkAuthFromSkillRoot,
  expandLarkAuthWithManagedSkills,
  inferOpenClawHomeFromSkillPath,
  listOpenClawBundledSkillRoots,
  getCachedSenderId,
  getDefaultSkillRoots,
  getAccountCredentials,
  inferSenderIdFromCtx,
  getSkillAuthCacheKey,
  resolveSkillReadTarget,
  resolveInstallAuthRecipient,
  sendAuthCard,
  startLogin,
  startWaitForAuth,
  resetRuntimeCaches,
  setApiConfigRef,
  setPluginApiRef,
  setLarkCliCommandRunnerForTest,
  setLarkCliDeviceWaitSpawnerForTest,
  selectAuthedUserProfile,
  checkScopes,
  normalizeAppScopeEntries,
  retainGrantedTenantScopes,
  normalizeAuthIdentity,
  selectExplicitSkillNames,
  isUserGrantWaiterDenial,
} from "../utils.js";
import { createLarkCliCommandRunner, okLarkCliResult } from "./helpers/lark-cli-mock.js";
import { normalizePathForAssert } from "./helpers/test-env.js";

test("getDefaultSkillRoots includes agent and OpenClaw global skill roots", () => {
  assert.deepEqual(getDefaultSkillRoots({}).map(normalizePathForAssert), [
    normalizePathForAssert(join(homedir(), ".agents", "skills")),
    normalizePathForAssert(join(homedir(), ".openclaw", "skills")),
    normalizePathForAssert(join(homedir(), ".openclaw", "workspace", "skills")),
  ]);
});

test("collectLarkAuthFromSkillRoot unions every skill declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-managed-auth-"));
  try {
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "alpha"), { recursive: true });
    mkdirSync(join(skillsRoot, "beta"), { recursive: true });
    mkdirSync(join(skillsRoot, "plain"), { recursive: true });
    writeFileSync(join(skillsRoot, "alpha", "SKILL.md"), `---
larkAuth:
  identity: app
  appScopes:
    - im:message
---
`);
    writeFileSync(join(skillsRoot, "beta", "SKILL.md"), `---
larkAuth:
  identity: user
  scopes:
    - contact:user.base:readonly
  userScopes:
    - contact:user.base:readonly
---
`);
    writeFileSync(join(skillsRoot, "plain", "SKILL.md"), `---
name: plain
---
`);

    const collected = collectLarkAuthFromSkillRoot(skillsRoot);
    assert.equal(collected.identity, "user");
    assert.equal(collected.skillCount, 2);
    assert.deepEqual(collected.scopes, ["contact:user.base:readonly", "im:message"]);
    assert.equal(collected.scopeInstallGrant["im:message"], "app");
    assert.equal(collected.scopeInstallGrant["contact:user.base:readonly"], "user");

    const expanded = expandLarkAuthWithManagedSkills({
      identity: "user",
      scopes: ["docs:document:readonly"],
      scopeInstallGrant: { "docs:document:readonly": "user" },
    }, { root: skillsRoot });
    assert.equal(expanded.bundled, true);
    assert.deepEqual(expanded.auth.scopes, [
      "contact:user.base:readonly",
      "docs:document:readonly",
      "im:message",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listOpenClawBundledSkillRoots includes agent workspace skill directories", () => {
  const home = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-agent-skills-"));
  try {
    const agentSkills = join(home, "workspace", "workbench-agent", "skills");
    const currentSkill = join(agentSkills, "papergames-weekly-report", "SKILL.md");
    mkdirSync(join(agentSkills, "papergames-weekly-report"), { recursive: true });
    mkdirSync(join(agentSkills, "other-skill"), { recursive: true });
    writeFileSync(currentSkill, `---
larkAuth:
  identity: user
  scopes:
    - im:message
---
`);
    writeFileSync(join(agentSkills, "other-skill", "SKILL.md"), `---
larkAuth:
  identity: user
  scopes:
    - contact:user.base:readonly
    - user:ou_4fc048c59c4820feda9d591cd213b480
---
`);

    const remoteSkill = "/root/.openclaw/workspace/workbench-agent/skills/papergames-weekly-report/SKILL.md";
    assert.equal(
      normalizePathForAssert(inferOpenClawHomeFromSkillPath(remoteSkill)),
      normalizePathForAssert(resolve("/root/.openclaw")),
    );
    const roots = listOpenClawBundledSkillRoots({ openclawHome: home, skillPath: currentSkill });
    assert.ok(roots.some((root) => normalizePathForAssert(root) === normalizePathForAssert(agentSkills)));

    const expanded = expandLarkAuthWithManagedSkills({
      identity: "user",
      scopes: ["im:message"],
      scopeInstallGrant: {},
    }, { openclawHome: home, skillPath: currentSkill });
    assert.equal(expanded.bundled, true);
    assert.equal(expanded.skillCount, 2);
    assert.deepEqual(expanded.auth.scopes, ["contact:user.base:readonly", "im:message"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("expandLarkAuthWithManagedSkills reads skills installed in ~/.openclaw/workspace/skills", () => {
  const home = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-workspace-skills-"));
  try {
    const sharedSkills = join(home, "workspace", "skills");
    mkdirSync(join(sharedSkills, "papergames-weekly-report"), { recursive: true });
    mkdirSync(join(sharedSkills, "byted-web-search"), { recursive: true });
    writeFileSync(join(sharedSkills, "papergames-weekly-report", "SKILL.md"), `---
larkAuth:
  identity: user
  scopes:
    - im:message
---
`);
    writeFileSync(join(sharedSkills, "byted-web-search", "SKILL.md"), `---
larkAuth:
  identity: user
  scopes:
    - search:message
---
`);
    const currentSkill = "/root/.openclaw/workspace/skills/papergames-weekly-report/SKILL.md";
    const roots = listOpenClawBundledSkillRoots({ openclawHome: home, skillPath: currentSkill });
    assert.ok(roots.some((root) => normalizePathForAssert(root) === normalizePathForAssert(sharedSkills)));

    const expanded = expandLarkAuthWithManagedSkills({
      identity: "user",
      scopes: ["im:message"],
      scopeInstallGrant: {},
    }, { openclawHome: home, skillPath: currentSkill });
    assert.equal(expanded.bundled, true);
    assert.equal(expanded.skillCount, 2);
    assert.deepEqual(expanded.auth.scopes, ["im:message", "search:message"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test("resolveInstallAuthRecipient discovers one verified matching profile", async () => {
  const calls = [];
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: { appId: "cli-auto", appSecret: "secret" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    calls,
    appId: "cli-auto",
    openId: "ou_auto",
    profiles: [{ name: "auto-profile", appId: "cli-auto" }],
  }));

  try {
    const result = await resolveInstallAuthRecipient({ accountId: "default" });
    assert.deepEqual(result, {
      ok: true,
      accountId: "default",
      appId: "cli-auto",
      profile: "auto-profile",
      openId: "ou_auto",
      source: "verified-profile",
    });
    assert.ok(calls.some((args) => args[0] === "--profile" && args[1] === "auto-profile"));
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
  }
});

test("resolveInstallAuthRecipient rejects multiple verified profiles", async () => {
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: { appId: "cli-auto", appSecret: "secret" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    appId: "cli-auto",
    openId: "ou_auto",
    profiles: [
      { name: "profile-a", appId: "cli-auto" },
      { name: "profile-b", appId: "cli-auto" },
    ],
  }));

  try {
    const result = await resolveInstallAuthRecipient({ accountId: "default" });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "recipient_ambiguous");
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
  }
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

test("revoked tenant scopes are missing on the next skill scope check", async () => {
  const catalog = normalizeAppScopeEntries([
    { scope: "contact:user.base:readonly", identity_type: "user" },
    { scope: "im:message", identity_type: "user" },
  ]);
  const entries = retainGrantedTenantScopes(catalog, [
    { scope_name: "contact:user.base:readonly", grant_status: 1 },
    { scope_name: "im:message", grant_status: 2 },
  ]);
  const result = await checkScopes(
    ["contact:user.base:readonly", "im:message"],
    {},
    { identity: "user", appScopeEntries: entries },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["im:message"]);
  assert.deepEqual(result.granted, ["contact:user.base:readonly"]);
});

test("explicit skill name does not treat a shorter prefix as the requested skill", () => {
  const text = "使用技能papergames-weekly-report-lite严格按照流程，生成本周的周报";
  const names = selectExplicitSkillNames(text, [
    "papergames-weekly-report",
    "papergames-weekly-report-lite",
    "byted-web-search",
  ]);
  assert.deepEqual(names, ["papergames-weekly-report-lite"]);

  const skillMap = new Map([
    ["/root/.openclaw/workspace/skills/papergames-weekly-report-lite/SKILL.md", "papergames-weekly-report-lite"],
    ["/root/.openclaw/workspace/skills/papergames-weekly-report/SKILL.md", "papergames-weekly-report"],
  ]);
  assert.deepEqual(selectExplicitSkillNames(text, skillMap), ["papergames-weekly-report-lite"]);
  assert.deepEqual(selectExplicitSkillNames(text, skillMap.values()), ["papergames-weekly-report-lite"]);
  assert.deepEqual(selectExplicitSkillNames(text, [...skillMap.keys()]), ["papergames-weekly-report-lite"]);
});

test("user grant waiter denial is recognized before the success grace period", () => {
  assert.equal(isUserGrantWaiterDenial({
    exited: true,
    exitCode: 1,
    output: "error: access_denied",
  }), true);
  assert.equal(isUserGrantWaiterDenial({
    denied: true,
    exited: false,
    exitCode: null,
  }), true);
  assert.equal(isUserGrantWaiterDenial({
    exited: true,
    exitCode: 0,
    output: "",
  }), false);
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

test("checkUserGrant keeps the verified lark profile", async () => {
  const calls = [];
  setPluginApiRef(null);
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: { appId: "cli_profile", appSecret: "secret" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    calls,
    appId: "cli_profile",
    openId: "ou_profile",
    grantedScopes: ["scope:a"],
  }));

  try {
    const result = await checkUserGrant(
      "ou_profile",
      ["scope:a"],
      { accountId: "default" },
      { larkProfile: "profile-b", requireScopeDetails: true },
    );
    assert.equal(result.ok, true);
    assert.ok(calls.some((args) => args[0] === "--profile" && args[1] === "profile-b" && args[2] === "auth"));
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setPluginApiRef(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
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

test("startLogin keeps the selected lark profile for user grants", async () => {
  const commandCalls = [];
  const spawnCalls = [];
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: { appId: "cli_profile", appSecret: "secret" },
        },
      },
    },
  });
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    calls: commandCalls,
    appId: "cli_profile",
  }));
  setLarkCliDeviceWaitSpawnerForTest((args) => {
    spawnCalls.push(args);
    return { started: true, pid: 5678 };
  });

  try {
    const result = await startLogin(
      ["scope:a"],
      { accountId: "default" },
      { identity: "user", authReason: "user_grant", larkProfile: "profile-b" },
    );
    assert.equal(result.provider, "lark-cli");
    assert.ok(commandCalls.some((args) => args[0] === "--profile" && args[1] === "profile-b" && args[2] === "config"));
    assert.ok(commandCalls.some((args) => args[0] === "--profile" && args[1] === "profile-b" && args[2] === "auth"));
    assert.ok(spawnCalls.some((args) => args[0] === "--profile" && args[1] === "profile-b"));
  } finally {
    setLarkCliCommandRunnerForTest(null);
    setLarkCliDeviceWaitSpawnerForTest(null);
    setApiConfigRef(null);
    resetRuntimeCaches();
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
    if (href.includes("/open-apis/application/v6/scopes")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              scopes: [{ scope_name: "scope:a", grant_status: 1 }],
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
test("registrationReady does not override missing app scopes", async () => {
  const oldFetch = globalThis.fetch;
  resetRuntimeCaches();
  setApiConfigRef({
    channels: {
      feishu: {
        accounts: {
          default: { appId: "cli_registration_only", appSecret: "secret_test" },
        },
      },
    },
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/oauth/v1/app/registration")) {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ token: "mock" }); },
      };
    }
    if (href.includes("tenant_access_token")) {
      return {
        ok: true,
        async json() {
          return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
        },
      };
    }
    if (href.includes("/open-apis/application/v6/applications/cli_registration_only")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: { app: { scopes: [{ scope: "scope:a", identity_type: "app" }] } },
          };
        },
      };
    }
    if (href.includes("/open-apis/application/v6/scopes")) {
      return {
        ok: true,
        async json() { return { code: 0, data: { scopes: [] } }; },
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  let authorized = false;
  try {
    startWaitForAuth({
      authTargetKey: "registration-only",
      skillName: "registration-only",
      deviceCode: "device-registration-only",
      missingKey: "scope:a",
      scopes: ["scope:a"],
      identity: "app",
      authReason: "app_scope",
      ctx: { accountId: "default" },
      onAuthorized() { authorized = true; },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(authorized, false);
  } finally {
    globalThis.fetch = oldFetch;
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
    if (href.includes("/open-apis/application/v6/scopes")) {
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              scopes: [
                { scope_name: "scope:a", grant_status: 1 },
                { scope_name: "scope:b", grant_status: 1 },
              ],
            },
          };
        },
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  let statusVerifyCount = 0;
  const larkCliCalls = [];
  setLarkCliCommandRunnerForTest(createLarkCliCommandRunner({
    calls: larkCliCalls,
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
      larkProfile: "profile-b",
      ctx: { accountId: "default" },
      authMessageId: "msg_app_scope",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(statusVerifyCount >= 1);
    assert.ok(larkCliCalls.some((args) => args[0] === "--profile" && args[1] === "profile-b" && args[2] === "auth"));
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
