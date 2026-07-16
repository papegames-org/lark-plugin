import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(pathname, value) {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

test("check:version passes for this repo", () => {
  const result = spawnSync("node", ["./scripts/check-version.js"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout || ""}\n${result.stderr || ""}`.trim());
});

test("check:version fails when manifest versions drift", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-version-"));

  writeJson(join(root, "package.json"), { version: "2.0.0" });
  writeJson(join(root, "package-lock.json"), {
    version: "2.0.1",
    packages: {
      "": { version: "2.0.1" },
    },
  });
  writeJson(join(root, "openclaw.plugin.json"), { version: "2.0.0" });

  const result = spawnSync("node", ["./scripts/check-version.js", "--root", root], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2, `${result.stdout || ""}\n${result.stderr || ""}`.trim());
  assert.match(result.stderr, /version mismatch/u);
});
