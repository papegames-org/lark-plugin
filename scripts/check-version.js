#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  process.stderr.write("Usage: node scripts/check-version.js [--root <dir>]\n");
}

function parseArgs(argv) {
  const args = { root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--root") {
      const next = argv[i + 1];
      if (!next) throw new Error("--root requires a value");
      args.root = next;
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

function repoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function validateVersionString(version, label) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(String(version || ""))) {
    throw new Error(`${label} has an invalid semver-like version: ${String(version || "<empty>")}`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root || repoRoot());

  const pkg = readJson(root, "package.json");
  const lock = readJson(root, "package-lock.json");
  const plugin = readJson(root, "openclaw.plugin.json");

  const versions = [
    { label: "package.json", value: pkg.version },
    { label: "package-lock.json", value: lock.version },
    { label: "package-lock.json packages[\"\"]", value: lock.packages?.[""]?.version },
    { label: "openclaw.plugin.json", value: plugin.version },
  ];

  for (const entry of versions) validateVersionString(entry.value, entry.label);

  const expected = versions[0].value;
  const mismatches = versions.filter((entry) => entry.value !== expected);

  if (mismatches.length > 0) {
    process.stderr.write(`version mismatch: expected ${expected}\n`);
    for (const entry of versions) {
      process.stderr.write(`- ${entry.label}: ${entry.value}\n`);
    }
    process.exit(2);
  }

  process.stdout.write(`check:version ok (${expected})\n`);
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}
