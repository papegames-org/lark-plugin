#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  process.stderr.write("Usage: node scripts/check-public.js [--root <dir>]\n");
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--root") {
      const next = argv[i + 1];
      if (!next) throw new Error("--root requires a value");
      args.root = resolve(next);
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

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const SKIP_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tgz"]);
const FORBIDDEN_FILE_BASENAMES = new Set([".npmrc", ".env", ".env.local", ".env.production", ".env.development", "id_rsa", "id_dsa"]);
const FORBIDDEN_FILE_EXTS = new Set([".pem", ".p12", ".pfx", ".key"]);
const MAX_BYTES = 1024 * 1024;

function isTextBuffer(buf) {
  // Heuristic: NUL indicates binary.
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function walk(dir, out) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Skip hidden dirs by default (except ".agents" which may contain skills).
      if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(full);
  }
}

function rel(root, pathname) {
  return pathname.startsWith(root) ? pathname.slice(root.length + 1) : pathname;
}

function addFinding(findings, root, severity, file, match, note) {
  findings.push({ severity, file: rel(root, file), match, note });
}

const SECRET_PATTERNS = [
  { name: "private_key_block", re: /-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/g },
  { name: "openai_api_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "github_pat", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
];

const PII_PATTERNS = [
  // Machine paths can leak usernames.
  { name: "abs_path_macos", re: /\/Users\/[^/\s]+/g },
  { name: "abs_path_linux", re: /\/home\/[^/\s]+/g },
  { name: "abs_path_windows", re: /[A-Za-z]:\\Users\\[^\\\s]+/g },
  // Basic emails. Allow example/test domains.
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g },
];

function isAllowedEmailDomain(domain) {
  const d = String(domain || "").toLowerCase();
  return d === "example.com" || d === "example.org" || d === "test.com" || d.endsWith(".example");
}

function scanFile(findings, root, file) {
  if (SKIP_FILES.has(basename(file))) return;
  const filename = basename(file);
  const ext = extname(file).toLowerCase();
  if (SKIP_EXTS.has(ext)) return;

  if (FORBIDDEN_FILE_BASENAMES.has(filename) || FORBIDDEN_FILE_EXTS.has(ext)) {
    addFinding(findings, root, "secret", file, "risky_file", filename);
    return;
  }

  const st = statSync(file);
  if (st.size > MAX_BYTES) return;

  const buf = readFileSync(file);
  if (!isTextBuffer(buf)) return;

  const text = buf.toString("utf8");

  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    const m = pattern.re.exec(text);
    if (m) {
      addFinding(findings, root, "secret", file, pattern.name, m[0].slice(0, 64));
    }
  }

  for (const pattern of PII_PATTERNS) {
    pattern.re.lastIndex = 0;
    let m;
    while ((m = pattern.re.exec(text))) {
      if (pattern.name === "email") {
        const domain = m[1];
        if (isAllowedEmailDomain(domain)) continue;
      }
      addFinding(findings, root, "pii", file, pattern.name, m[0].slice(0, 80));
      break;
    }
  }

  // Heuristic: common secret keys assigned to a long-ish literal.
  // Only triggers when the identifier is used as a property/assignment key (":", "="),
  // avoiding false positives where the string appears as a normal value (e.g. "client_secret").
  const assign = text.match(
    /\b(appSecret|app_secret|clientSecret|client_secret|refresh_token|access_token)\b\s*[:=]\s*["']([^"']{12,})["']/,
  );
  if (assign) {
    const raw = String(assign[2] || "");
    const lowered = raw.toLowerCase();
    const looksLikePlaceholder =
      lowered.includes("test") ||
      lowered.includes("example") ||
      lowered.includes("dummy") ||
      lowered === "changeme" ||
      lowered.includes("xxx");
    if (!looksLikePlaceholder) {
      addFinding(findings, root, "secret", file, "inline_secret_assignment", assign[0].slice(0, 120));
    }
  }
}

function format(findings) {
  const lines = [];
  for (const f of findings) {
    lines.push(`[${f.severity}] ${f.file} ${f.match}${f.note ? `: ${f.note}` : ""}`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = [];
  walk(args.root, files);

  const findings = [];
  for (const file of files) {
    scanFile(findings, args.root, file);
  }

  const secretCount = findings.filter((f) => f.severity === "secret").length;
  const piiCount = findings.filter((f) => f.severity === "pii").length;

  if (findings.length > 0) {
    process.stderr.write(`${format(findings)}\n`);
  }

  if (secretCount > 0 || piiCount > 0) {
    process.stderr.write(
      `\ncheck:public failed (secrets=${secretCount}, pii=${piiCount}).\n`,
    );
    process.exit(2);
  }

  process.stdout.write("check:public ok\n");
}

main();
