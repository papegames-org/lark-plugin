import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectSkillAuthManifest } from "../skill-auth-manifest.js";

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "openclaw-skill-auth-manifest-"));
}

function writeSkill(root, name, frontmatter) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${name}\n${frontmatter}\n---\n# ${name}\n`);
  return skillPath;
}

function sampleConfig(workspaceRoot, extra = {}) {
  return {
    agents: {
      list: [
        { id: "main", workspace: workspaceRoot },
        { id: "sub-agent", workspace: join(workspaceRoot, "sub") },
      ],
    },
    bindings: [
      { agentId: "main", match: { channel: "feishu", accountId: "default" } },
      { agentId: "sub-agent", match: { channel: "feishu", accountId: "sub-agent" } },
    ],
    channels: {
      feishu: {
        appId: "app_main",
        appSecret: "secret-main",
        brand: "feishu",
        accounts: {
          default: {},
          "sub-agent": { appId: "app_sub", appSecret: "secret-sub", brand: "lark" },
        },
      },
    },
    ...extra,
  };
}

test("collectSkillAuthManifest aggregates app and user grants by application", () => {
  const workspace = makeTempRoot();
  const skillsRoot = join(workspace, "skills");
  mkdirSync(skillsRoot, { recursive: true });

  writeSkill(skillsRoot, "alpha", `metadata: { "openclaw": { "larkAuth": { "identity": "user", "scopes": ["im:message", "contact:user.base:readonly"], "appScopes": ["im:message"], "userScopes": ["contact:user.base:readonly"] } } }`);
  writeSkill(skillsRoot, "beta", `metadata:
  openclaw:
    larkAuth:
      identity: app
      appScopes:
        - im:message
        - drive:file:readonly`);
  writeSkill(skillsRoot, "gamma", `description: no auth`);

  const manifest = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [skillsRoot],
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.errors.length, 0);
  assert.equal(manifest.unresolved.length, 0);
  assert.equal(manifest.totals.skills, 3);
  assert.equal(manifest.totals.skillsWithAuth, 2);
  assert.equal(manifest.apps.length, 1);
  assert.equal(manifest.apps[0].accountId, "default");
  assert.equal(manifest.apps[0].appId, "app_main");
  assert.deepEqual(manifest.apps[0].installScopes.app, ["drive:file:readonly", "im:message"]);
  assert.deepEqual(manifest.apps[0].installScopes.user, ["contact:user.base:readonly"]);
  assert.deepEqual(manifest.apps[0].installScopes.unknown, []);
  assert.deepEqual(manifest.apps[0].personalOAuthScopes, ["contact:user.base:readonly"]);
  assert.deepEqual(manifest.apps[0].skills.map((skill) => skill.skillName), ["alpha", "beta"]);
  assert.match(manifest.hash, /^[a-f0-9]{64}$/u);
});

test("collectSkillAuthManifest preserves same scope in both install buckets", () => {
  const workspace = makeTempRoot();
  const skillsRoot = join(workspace, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  writeSkill(skillsRoot, "dual", `larkAuth:
  identity: user
  appScopes:
    - docs:doc
  userScopes:
    - docs:doc`);

  const manifest = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [skillsRoot],
  });

  assert.deepEqual(manifest.apps[0].installScopes.app, ["docs:doc"]);
  assert.deepEqual(manifest.apps[0].installScopes.user, ["docs:doc"]);
  assert.deepEqual(manifest.apps[0].personalOAuthScopes, ["docs:doc"]);
});

test("collectSkillAuthManifest separates multiple accounts and reports unresolved roots", () => {
  const workspace = makeTempRoot();
  const mainRoot = join(workspace, "skills");
  const subRoot = join(workspace, "sub", "skills");
  const sharedRoot = join(workspace, "shared-skills");
  mkdirSync(mainRoot, { recursive: true });
  mkdirSync(subRoot, { recursive: true });
  mkdirSync(sharedRoot, { recursive: true });

  writeSkill(mainRoot, "main-skill", `larkAuth:
  identity: user
  scopes:
    - main:scope`);
  writeSkill(subRoot, "sub-skill", `larkAuth:
  identity: app
  appScopes:
    - sub:scope`);
  writeSkill(sharedRoot, "shared-skill", `larkAuth:
  identity: user
  scopes:
    - shared:scope`);

  const manifest = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [mainRoot, subRoot, sharedRoot],
  });

  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.apps.map((app) => app.key), ["feishu:app_main", "lark:app_sub"]);
  assert.deepEqual(manifest.unresolved.map((entry) => entry.skillName), ["shared-skill"]);
  assert.equal(manifest.unresolved[0].reason, "account_unresolved");
});

test("collectSkillAuthManifest preserves legacy scopes as unknown install grants", () => {
  const workspace = makeTempRoot();
  const skillsRoot = join(workspace, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  writeSkill(skillsRoot, "legacy-app", `larkAuth:
  identity: app
  scopes:
    - legacy:scope`);
  writeSkill(skillsRoot, "legacy-user", `larkAuth:
  identity: user
  scopes:
    - user:legacy`);

  const manifest = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [skillsRoot],
  });

  assert.deepEqual(manifest.apps[0].installScopes.app, []);
  assert.deepEqual(manifest.apps[0].installScopes.user, []);
  assert.deepEqual(manifest.apps[0].installScopes.unknown, ["legacy:scope", "user:legacy"]);
  assert.deepEqual(manifest.apps[0].personalOAuthScopes, ["user:legacy"]);
});

test("collectSkillAuthManifest reports invalid JSON larkAuth declarations", () => {
  const workspace = makeTempRoot();
  const skillsRoot = join(workspace, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  writeSkill(skillsRoot, "bad-json", `metadata: { "openclaw": { "larkAuth": { "identity": "user", "scopes": [] } } }`);

  const manifest = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [skillsRoot],
  });

  assert.equal(manifest.complete, false);
  assert.equal(manifest.errors.length, 1);
  assert.equal(manifest.errors[0].reason, "invalid_lark_auth");
  assert.equal(manifest.totals.skillsWithAuth, 0);
});

test("collectSkillAuthManifest uses configured default Feishu account in multi-account configs", () => {
  const workspace = makeTempRoot();
  const sharedRoot = join(workspace, "shared-skills");
  mkdirSync(sharedRoot, { recursive: true });
  writeSkill(sharedRoot, "shared-skill", `larkAuth:
  identity: user
  userScopes:
    - shared:scope`);

  const manifest = collectSkillAuthManifest({
    config: sampleConfig(workspace, {
      plugins: {
        entries: {
          "openclaw-skill-runtime": {
            config: { defaultFeishuAccountId: "sub-agent" },
          },
        },
      },
    }),
    skillRoots: [sharedRoot],
  });

  assert.equal(manifest.complete, true);
  assert.equal(manifest.unresolved.length, 0);
  assert.equal(manifest.apps.length, 1);
  assert.equal(manifest.apps[0].accountId, "sub-agent");
  assert.equal(manifest.apps[0].appId, "app_sub");
});

test("collectSkillAuthManifest accepts resolved skills and records scan errors", () => {
  const workspace = makeTempRoot();
  const missingRoot = join(workspace, "missing");
  const config = sampleConfig(workspace);
  const manifest = collectSkillAuthManifest({
    config,
    skillRoots: [missingRoot],
    resolvedSkills: [
      {
        name: "runtime-skill",
        accountId: "default",
        content: `---
name: runtime-skill
larkAuth:
  identity: app
  appScopes: ["runtime:scope"]
---
# Runtime Skill
`,
      },
    ],
  });

  assert.equal(manifest.complete, false);
  assert.equal(manifest.errors[0].reason, "root_missing");
  assert.equal(manifest.apps.length, 1);
  assert.deepEqual(manifest.apps[0].installScopes.app, ["runtime:scope"]);
});

test("collectSkillAuthManifest hash changes when skill auth content changes", () => {
  const workspace = makeTempRoot();
  const skillsRoot = join(workspace, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const skillPath = writeSkill(skillsRoot, "mutable", `larkAuth:
  identity: user
  scopes:
    - scope:a`);

  const first = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [skillsRoot],
  });

  writeFileSync(skillPath, `---
name: mutable
larkAuth:
  identity: user
  scopes:
    - scope:a
    - scope:b
---
# Mutable
`);

  const second = collectSkillAuthManifest({
    config: sampleConfig(workspace),
    skillRoots: [skillsRoot],
  });

  assert.notEqual(first.hash, second.hash);
  assert.deepEqual(second.apps[0].personalOAuthScopes, ["scope:a", "scope:b"]);
});
