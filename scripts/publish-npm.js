#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://registry.npmjs.org/";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const token = process.env.NPM_TOKEN;
if (!token) {
  fail("Missing NPM_TOKEN. Run with: NPM_TOKEN=... npm run release:publish");
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

  const check = run("npm", ["run", "release:check"], { env });
  if (check.status !== 0) process.exit(check.status || 1);

  const publish = run("npm", ["publish", "--access", "public", "--registry", REGISTRY], { env });
  process.exit(publish.status || 0);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
