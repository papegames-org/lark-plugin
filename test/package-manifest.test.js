import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package manifest omits legacy CLI helpers and extra runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const files = Array.isArray(pkg.files) ? pkg.files : [];

  assert.ok(!files.includes("openclaw-runtime.js"));
  assert.ok(!("bundledDependencies" in pkg));
  assert.equal(pkg.scripts?.test, "node --test");
  assert.equal(pkg.scripts?.["check:version"], "node ./scripts/check-version.js");
  assert.match(pkg.scripts?.["release:check"] || "", /check:version/u);
  assert.ok(!("dependencies" in pkg));
  assert.ok(files.includes("bin"));
  assert.equal(pkg.bin?.["openclaw-skill-runtime"], "bin/openclaw-skill-runtime.js");
});
