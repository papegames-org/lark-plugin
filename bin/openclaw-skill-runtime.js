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

export function installOpenClawWorkflow(options = {}) {
  const runCommand = options.runCommand || run;
  const packageRoot = options.packageRoot || repoRoot();
  const staging = options.stagingDir || mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-install-"));
  const openclawVersion = runCommand("openclaw", ["--version"], { stdio: "pipe" });
  if (openclawVersion.status !== 0) {
    return {
      exitCode: openclawVersion.status || 1,
      installed: false,
      restarted: false,
      inspected: false,
      error: "openclaw CLI not found. Install OpenClaw first, then retry.",
    };
  }

  const env = {
    ...process.env,
    npm_config_cache: inferNpmCacheDir(),
    npm_config_update_notifier: "false",
  };

  const packed = runCommand("npm", ["pack", packageRoot], { stdio: "pipe", cwd: staging, env });
  if (packed.status !== 0) {
    return {
      exitCode: packed.status || 1,
      installed: false,
      restarted: false,
      inspected: false,
      error: `${packed.stdout || ""}${packed.stderr || ""}\nnpm pack failed; cannot produce tgz for OpenClaw install.`.trim(),
    };
  }

  const tgz = extractPackedFilename(`${packed.stdout || ""}\n${packed.stderr || ""}`);
  if (!tgz) {
    return {
      exitCode: 1,
      installed: false,
      restarted: false,
      inspected: false,
      error: "Unable to find packed .tgz filename in npm output.",
    };
  }

  const tgzPath = join(staging, tgz);
  const install = runCommand("openclaw", ["plugins", "install", tgzPath], { stdio: "inherit" });
  if (install.status !== 0) {
    return {
      exitCode: install.status || 1,
      installed: false,
      restarted: false,
      inspected: false,
      error: `${install.stderr || install.stdout || "plugin installation failed"}`.trim(),
    };
  }

  const restart = runCommand("openclaw", ["gateway", "restart"], { stdio: "pipe" });
  if (restart.status !== 0) {
    return {
      exitCode: 3,
      installed: true,
      restarted: false,
      inspected: false,
      error: `plugin installed, but Gateway restart failed: ${restart.stderr || restart.stdout || `exit ${restart.status}`}`.trim(),
    };
  }

  const inspect = runCommand(
    "openclaw",
    ["plugins", "inspect", "openclaw-skill-runtime", "--runtime", "--json"],
    { stdio: "pipe" },
  );
  if (inspect.status !== 0) {
    return {
      exitCode: 4,
      installed: true,
      restarted: true,
      inspected: false,
      error: `plugin installed and Gateway restarted, but runtime inspect failed: ${inspect.stderr || inspect.stdout || `exit ${inspect.status}`}`.trim(),
    };
  }
  return {
    exitCode: 0,
    installed: true,
    restarted: true,
    inspected: true,
    inspectOutput: String(inspect.stdout || "").trim(),
  };
}

function installOpenClaw() {
  const outcome = installOpenClawWorkflow();
  if (outcome.error) process.stderr.write(`${outcome.error}\n`);
  else process.stdout.write("Plugin installed, Gateway restarted, and runtime inspect completed.\n");
  process.exit(outcome.exitCode);
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return 0;
  }

  if (cmd === "install-openclaw") {
    installOpenClaw();
    return 0;
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  printHelp();
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
