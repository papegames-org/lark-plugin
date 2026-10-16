#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const token = process.env.NPM_TOKEN;
if (!token) {
  fail("Missing NPM_TOKEN. Run with: NPM_TOKEN=... npm run release:publish");
}

function shouldPromoteLatest() {
  if (process.argv.includes("--promote-latest")) return true;
  const raw = process.env.NPM_PROMOTE_LATEST;
  return raw === "1" || raw === "true";
}

const tempDir = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-publish-"));
const npmrcPath = join(tempDir, ".npmrc");

try {
  writeFileSync(npmrcPath, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });

  const env = {
    ...process.env,
    npm_config_registry: REGISTRY,
    npm_config_userconfig: npmrcPath,
    npm_config_update_notifier: "false",
  };

  const npm = npmCommand();
  const check = run(npm, ["run", "release:check"], { env });
  if (check.status !== 0) process.exit(check.status || 1);

  const publish = run(npm, ["publish", "--access", "public", "--registry", REGISTRY], { env });
  if (publish.status !== 0) process.exit(publish.status || 1);

  if (shouldPromoteLatest()) {
    const tag = run(
      npm,
      ["dist-tag", "add", `${pkg.name}@${pkg.version}`, "latest", "--registry", REGISTRY],
      { env },
    );
    process.exit(tag.status || 0);
  }

  process.exit(0);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
