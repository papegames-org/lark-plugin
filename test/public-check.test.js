import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("check:public passes for this repo", () => {
  const result = spawnSync("node", ["./scripts/check-public.js"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout || ""}\n${result.stderr || ""}`.trim());
});

test("check:public detects npm tokens in a target root", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-public-"));
  const token = `npm_${"abcdefghijklmnopqrstuvwxyz"}123456`;
  writeFileSync(join(root, "token.txt"), `${token}\n`);

  const result = spawnSync("node", ["./scripts/check-public.js", "--root", root], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2, `${result.stdout || ""}\n${result.stderr || ""}`.trim());
  assert.match(result.stderr, /npm_token/u);
});
