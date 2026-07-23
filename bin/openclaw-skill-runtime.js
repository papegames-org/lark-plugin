#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function printHelp() {
  process.stdout.write(
    [
      "openclaw-skill-runtime (helper CLI)",
      "",
      "Commands:",
      "  install-openclaw    Pack this package and install into OpenClaw",
      "",
      "Examples:",
      "  npx @jianguo_paper/openclaw-skill-runtime@latest install-openclaw",
      "",
    ].join("\n"),
  );
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: options.stdio || "inherit",
    cwd: options.cwd,
    env: options.env,
  });
  return result;
}

function extractPackedFilename(text) {
  const lines = String(text || "")
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].endsWith(".tgz")) return lines[i];
  }
  return null;
}

function repoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

function inferNpmCacheDir() {
  return join(tmpdir(), "openclaw-skill-runtime-npm-cache");
}

function installOpenClaw() {
  const openclawVersion = run("openclaw", ["--version"], { stdio: "pipe" });
  if (openclawVersion.status !== 0) {
    process.stderr.write(
      "openclaw CLI not found. Install OpenClaw first, then retry.\n",
    );
    process.exit(openclawVersion.status || 1);
  }

  const staging = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-install-"));
  const env = {
    ...process.env,
    npm_config_cache: inferNpmCacheDir(),
    npm_config_update_notifier: "false",
  };

  const packed = run("npm", ["pack", repoRoot()], { stdio: "pipe", cwd: staging, env });
  if (packed.status !== 0) {
    process.stderr.write(`${packed.stdout || ""}${packed.stderr || ""}`);
    process.stderr.write("\nnpm pack failed; cannot produce tgz for OpenClaw install.\n");
    process.exit(packed.status || 1);
  }

  const tgz = extractPackedFilename(`${packed.stdout || ""}\n${packed.stderr || ""}`);
  if (!tgz) {
    process.stderr.write(`${packed.stdout || ""}${packed.stderr || ""}`);
    process.stderr.write("\nUnable to find packed .tgz filename in npm output.\n");
    process.exit(1);
  }

  const tgzPath = join(staging, tgz);
  const install = run("openclaw", ["plugins", "install", tgzPath], { stdio: "inherit" });
  if (install.status !== 0) {
    process.exit(install.status || 1);
  }

  const configureHookAccess = run("openclaw", [
    "config",
    "set",
    "plugins.entries.openclaw-skill-runtime.hooks.allowConversationAccess",
    "true",
  ], { stdio: "inherit" });
  if (configureHookAccess.status !== 0) {
    process.stderr.write(
      "Plugin installed, but enabling before_agent_run access failed. " +
      "Run: openclaw config set plugins.entries.openclaw-skill-runtime.hooks.allowConversationAccess true\n",
    );
    process.exit(configureHookAccess.status || 1);
  }

  process.stdout.write("Plugin installed and early skill authorization enabled. Restart OpenClaw Gateway before testing.\n");
  process.exit(0);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === "-h" || cmd === "--help") {
  printHelp();
  process.exit(0);
}

if (cmd === "install-openclaw") {
  installOpenClaw();
  process.exit(0);
}

process.stderr.write(`Unknown command: ${cmd}\n`);
printHelp();
process.exit(2);
