#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  process.stderr.write(
    "Usage: node scripts/run-npm-pack.js [--dry-run] [--dest <dir>] [--pkg <dir>]\n",
  );
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    dest: null,
    pkgDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (value === "--dest") {
      const next = argv[i + 1];
      if (!next) throw new Error("--dest requires a value");
      args.dest = next;
      i += 1;
      continue;
    }
    if (value === "--pkg") {
      const next = argv[i + 1];
      if (!next) throw new Error("--pkg requires a value");
      args.pkgDir = next;
      i += 1;
      continue;
    }
    if (value === "-h" || value === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${value}`);
  }
  return args;
}

function findRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function inferCacheDir() {
  // Some environments end up with root-owned ~/.npm. A per-run temp cache avoids that.
  const base = ensureDir(join(tmpdir(), "openclaw-skill-runtime-npm-cache"));
  return base;
}

function runNpmPack({ pkgDir, destDir, dryRun }) {
  const env = {
    ...process.env,
    npm_config_cache: inferCacheDir(),
    npm_config_update_notifier: "false",
  };

  const cwd = destDir ? ensureDir(destDir) : mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-pack-"));
  const argv = ["pack"];
  if (dryRun) argv.push("--dry-run");
  argv.push(pkgDir);

  const npmCommand = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...argv] : argv;
  const result = spawnSync(npmCommand, npmArgs, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const message = details ? `npm pack failed:\n${details}` : "npm pack failed";
    const error = new Error(message);
    error.exitCode = result.status;
    throw error;
  }

  return { cwd, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function extractPackedFilename(output) {
  const lines = String(output || "")
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].endsWith(".tgz")) return lines[i];
  }
  return null;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const pkgDir = resolve(args.pkgDir || findRepoRoot());
  const destDir = args.dest ? resolve(args.dest) : null;

  const packed = runNpmPack({ pkgDir, destDir, dryRun: args.dryRun });
  const packedName = extractPackedFilename(`${packed.stdout}\n${packed.stderr}`);

  if (!args.dryRun && packedName) {
    process.stdout.write(`${join(packed.cwd, packedName)}\n`);
  } else {
    process.stdout.write(packed.stdout);
    if (packed.stderr) process.stderr.write(packed.stderr);
  }
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(Number(error?.exitCode || 1));
}

