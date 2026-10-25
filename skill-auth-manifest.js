import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { readLarkAuthFromContent } from "./parse-meta.js";

const SCHEMA_VERSION = 1;
const MAX_SCAN_DEPTH = 4;

function normalizeString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeIdentity(value) {
  const raw = String(value || "user").trim().toLowerCase();
  if (["app", "application", "tenant", "bot"].includes(raw)) return "app";
  return "user";
}

function normalizeBrand(value) {
  const raw = String(value || "feishu").trim().toLowerCase();
  return raw || "feishu";
}

function normalizeAccountId(value) {
  return normalizeString(value) || "default";
}

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function relativeSkillName(skillPath) {
  return basename(dirname(skillPath));
}

function mergeAccountConfig(feishuCfg = {}, accountEntry = {}) {
  return {
    ...feishuCfg,
    ...(accountEntry && typeof accountEntry === "object" ? accountEntry : {}),
  };
}

function hasAccountCredentials(entry) {
  return Boolean(normalizeString(entry?.appId) && normalizeString(entry?.appSecret));
}

function buildAccounts(config = {}) {
  const feishuCfg = config?.channels?.feishu || {};
  const configured = feishuCfg.accounts && typeof feishuCfg.accounts === "object"
    ? feishuCfg.accounts
    : {};
  const accounts = new Map();

  const defaultEntry = mergeAccountConfig(feishuCfg, configured.default);
  if (hasAccountCredentials(defaultEntry) || normalizeString(defaultEntry.appId)) {
    accounts.set("default", {
      accountId: "default",
      appId: normalizeString(defaultEntry.appId),
      brand: normalizeBrand(defaultEntry.brand || feishuCfg.brand),
    });
  }

  for (const [accountId, accountEntry] of Object.entries(configured)) {
    if (accountId === "default") continue;
    const merged = mergeAccountConfig(feishuCfg, accountEntry);
    if (!hasAccountCredentials(merged) && !normalizeString(merged.appId)) continue;
    accounts.set(accountId, {
      accountId,
      appId: normalizeString(merged.appId),
      brand: normalizeBrand(merged.brand || feishuCfg.brand),
    });
  }

  if (accounts.size === 0 && normalizeString(feishuCfg.appId)) {
    accounts.set("default", {
      accountId: "default",
      appId: normalizeString(feishuCfg.appId),
      brand: normalizeBrand(feishuCfg.brand),
    });
  }

  return accounts;
}

function accountIdFromBinding(config = {}, agentId) {
  const id = normalizeString(agentId);
  if (!id) return null;
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  for (const binding of bindings) {
    if (normalizeString(binding?.agentId) !== id) continue;
    const match = binding?.match || {};
    if (String(match.channel || "").trim() !== "feishu") continue;
    return normalizeAccountId(match.accountId);
  }
  return null;
}

function buildAgentRoutes(config = {}, accounts = new Map()) {
  const routes = new Map();
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    const agentId = normalizeString(agent?.id);
    if (!agentId) continue;
    let accountId = accountIdFromBinding(config, agentId);
    if (!accountId && accounts.has(agentId)) accountId = agentId;
    if (!accountId && agentId === "main" && accounts.has("default")) accountId = "default";
    if (!accountId) continue;
    routes.set(agentId, accountId);
  }
  return routes;
}

function getConfiguredDefaultAccountId(config = {}, options = {}) {
  const candidates = [
    options?.defaultFeishuAccountId,
    options?.pluginConfig?.defaultFeishuAccountId,
    config?.plugins?.entries?.["openclaw-skill-runtime"]?.config?.defaultFeishuAccountId,
    config?.plugins?.["openclaw-skill-runtime"]?.config?.defaultFeishuAccountId,
    config?.openclawSkillRuntime?.defaultFeishuAccountId,
  ];
  for (const candidate of candidates) {
    const accountId = normalizeString(candidate);
    if (accountId) return accountId;
  }
  return null;
}

function normalizeRootEntry(entry) {
  if (typeof entry === "string") {
    return { root: resolve(entry), accountId: null, agentId: null };
  }
  if (!entry || typeof entry !== "object") return null;
  const root = normalizeString(entry.root || entry.path || entry.skillRoot);
  if (!root) return null;
  return {
    root: resolve(root),
    accountId: normalizeString(entry.accountId),
    agentId: normalizeString(entry.agentId),
  };
}

function inferRootAccount(rootEntry, config = {}, accounts = new Map(), agentRoutes = new Map(), options = {}) {
  if (rootEntry.accountId) return normalizeAccountId(rootEntry.accountId);
  if (rootEntry.agentId && agentRoutes.has(rootEntry.agentId)) return agentRoutes.get(rootEntry.agentId);

  const root = resolve(rootEntry.root);
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    const agentId = normalizeString(agent?.id);
    if (!agentId || !agent?.workspace) continue;
    const skillRoot = resolve(join(String(agent.workspace), "skills"));
    if (root === skillRoot || root.startsWith(`${skillRoot}/`)) {
      if (agentRoutes.has(agentId)) return agentRoutes.get(agentId);
    }
  }

  if (accounts.size === 1) return [...accounts.keys()][0];
  const configuredDefault = getConfiguredDefaultAccountId(config, options);
  if (configuredDefault && accounts.has(configuredDefault)) return configuredDefault;
  return null;
}

function addError(errors, target, reason, message) {
  errors.push({
    target,
    reason,
    message: message || reason,
  });
}

function walkSkillFiles(root, errors, out, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    addError(errors, root, "scan_failed", error?.message || "unable to scan skill root");
    return;
  }

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkSkillFiles(full, errors, out, depth + 1);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(resolve(full));
    }
  }
}

function collectRootSkills(skillRoots, config, accounts, agentRoutes, errors, options = {}) {
  const skills = [];
  for (const rawEntry of skillRoots || []) {
    const rootEntry = normalizeRootEntry(rawEntry);
    if (!rootEntry) continue;
    if (!existsSync(rootEntry.root)) {
      addError(errors, rootEntry.root, "root_missing", "skill root does not exist");
      continue;
    }
    try {
      if (!statSync(rootEntry.root).isDirectory()) {
        addError(errors, rootEntry.root, "root_not_directory", "skill root is not a directory");
        continue;
      }
    } catch (error) {
      addError(errors, rootEntry.root, "stat_failed", error?.message || "unable to stat skill root");
      continue;
    }

    const paths = [];
    walkSkillFiles(rootEntry.root, errors, paths);
    const accountId = inferRootAccount(rootEntry, config, accounts, agentRoutes, options);
    for (const skillPath of paths) {
      skills.push({
        skillPath,
        skillName: relativeSkillName(skillPath),
        accountId,
        source: "root",
      });
    }
  }
  return skills;
}

function normalizeResolvedSkill(entry, config, accounts, agentRoutes) {
  if (typeof entry === "string") {
    return {
      skillPath: resolve(entry),
      skillName: relativeSkillName(entry),
      accountId: accounts.size === 1 ? [...accounts.keys()][0] : null,
      content: null,
      source: "resolvedSkills",
    };
  }
  if (!entry || typeof entry !== "object") return null;
  const rawPath = normalizeString(entry.skillPath || entry.path || entry.file || entry.filename);
  const content = typeof entry.content === "string" ? entry.content : null;
  if (!rawPath && !content) return null;

  const accountId =
    normalizeString(entry.accountId) ||
    (normalizeString(entry.agentId) && agentRoutes.get(normalizeString(entry.agentId))) ||
    (accounts.size === 1 ? [...accounts.keys()][0] : null);
  const skillPath = rawPath ? resolve(rawPath) : `resolved:${entry.skillName || entry.name || "unknown"}`;
  return {
    skillPath,
    skillName: normalizeString(entry.skillName || entry.name) || relativeSkillName(skillPath),
    accountId,
    content,
    source: "resolvedSkills",
  };
}

function readSkillAuth(skill, errors) {
  let content = skill.content;
  if (content === null || content === undefined) {
    try {
      content = readFileSync(skill.skillPath, "utf8");
    } catch (error) {
      addError(errors, skill.skillPath, "read_failed", error?.message || "unable to read SKILL.md");
      return null;
    }
  }
  const auth = readLarkAuthFromContent(content);
  if (!auth && /["']?larkAuth["']?\s*:/u.test(content)) {
    addError(errors, skill.skillPath, "invalid_lark_auth", "larkAuth was present but did not contain usable scopes");
  }
  return auth;
}

function grantsForScope(auth, scope) {
  const multi = auth?.scopeInstallGrants?.[scope];
  if (Array.isArray(multi) && multi.length) return uniqueSorted(multi);
  const single = auth?.scopeInstallGrant?.[scope];
  if (single === "app" || single === "user") return [single];
  return ["unknown"];
}

function needsPersonalOAuth(auth, scope) {
  const grants = grantsForScope(auth, scope);
  return grants.some((grant) => grant === "user" || grant === "unknown");
}

function createAppBucket(account) {
  return {
    key: `${account.brand}:${account.appId || account.accountId}`,
    accountId: account.accountId,
    appId: account.appId,
    brand: account.brand,
    skills: [],
    installScopes: {
      app: [],
      user: [],
      unknown: [],
    },
    personalOAuthScopes: [],
  };
}

function addSkillToApp(app, skill, auth) {
  app.skills.push({
    skillName: skill.skillName,
    skillPath: skill.skillPath,
    source: skill.source,
    identity: normalizeIdentity(auth.identity),
    scopes: uniqueSorted(auth.scopes),
  });

  for (const scope of auth.scopes || []) {
    for (const grant of grantsForScope(auth, scope)) {
      const bucket = grant === "app" || grant === "user" ? grant : "unknown";
      app.installScopes[bucket].push(scope);
    }
  }

  if (normalizeIdentity(auth.identity) === "user") {
    app.personalOAuthScopes.push(...auth.scopes.filter((scope) => needsPersonalOAuth(auth, scope)));
  }
}

function finalizeApp(app) {
  app.skills.sort((a, b) => {
    const byName = a.skillName.localeCompare(b.skillName);
    if (byName !== 0) return byName;
    return a.skillPath.localeCompare(b.skillPath);
  });
  app.installScopes = {
    app: uniqueSorted(app.installScopes.app),
    user: uniqueSorted(app.installScopes.user),
    unknown: uniqueSorted(app.installScopes.unknown),
  };
  app.personalOAuthScopes = uniqueSorted(app.personalOAuthScopes);
  return app;
}

function stableForHash(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    apps: manifest.apps.map((app) => ({
      key: app.key,
      accountId: app.accountId,
      appId: app.appId,
      brand: app.brand,
      skills: app.skills.map((skill) => ({
        skillPath: skill.skillPath,
        identity: skill.identity,
        scopes: skill.scopes,
      })),
      installScopes: app.installScopes,
      personalOAuthScopes: app.personalOAuthScopes,
    })),
    unresolved: manifest.unresolved,
    errors: manifest.errors.map((error) => ({
      target: error.target,
      reason: error.reason,
    })),
  };
}

function hashManifest(manifest) {
  return createHash("sha256")
    .update(JSON.stringify(stableForHash(manifest)))
    .digest("hex");
}

export function collectSkillAuthManifest(options = {}) {
  const config = options.config || {};
  const accounts = buildAccounts(config);
  const agentRoutes = buildAgentRoutes(config, accounts);
  const errors = [];
  const unresolved = [];
  const discovered = [
    ...collectRootSkills(options.skillRoots || [], config, accounts, agentRoutes, errors, options),
  ];

  for (const entry of options.resolvedSkills || []) {
    const normalized = normalizeResolvedSkill(entry, config, accounts, agentRoutes);
    if (normalized) discovered.push(normalized);
  }

  const appsByKey = new Map();
  let skillsWithAuth = 0;
  for (const skill of discovered) {
    const auth = readSkillAuth(skill, errors);
    if (!auth || !Array.isArray(auth.scopes) || auth.scopes.length === 0) continue;
    skillsWithAuth += 1;

    const accountId = normalizeString(skill.accountId);
    const account = accountId ? accounts.get(accountId) : null;
    if (!account || !account.appId) {
      unresolved.push({
        skillName: skill.skillName,
        skillPath: skill.skillPath,
        accountId,
        reason: accountId ? "account_not_configured" : "account_unresolved",
      });
      continue;
    }

    const key = `${account.brand}:${account.appId}`;
    if (!appsByKey.has(key)) appsByKey.set(key, createAppBucket(account));
    addSkillToApp(appsByKey.get(key), skill, auth);
  }

  const apps = [...appsByKey.values()].map(finalizeApp).sort((a, b) => a.key.localeCompare(b.key));
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    complete: errors.length === 0 && unresolved.length === 0,
    hash: null,
    apps,
    unresolved: unresolved.sort((a, b) => a.skillPath.localeCompare(b.skillPath)),
    errors: errors.sort((a, b) => `${a.target}:${a.reason}`.localeCompare(`${b.target}:${b.reason}`)),
    totals: {
      skills: discovered.length,
      skillsWithAuth,
    },
  };
  manifest.hash = hashManifest(manifest);
  return manifest;
}
