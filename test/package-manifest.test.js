import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package manifest omits legacy CLI helpers and extra runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const files = Array.isArray(pkg.files) ? pkg.files : [];

  assert.ok(!files.includes("bin"));
  assert.ok(!files.includes("openclaw-runtime.js"));
  assert.ok(!("bundledDependencies" in pkg));
  assert.deepEqual(pkg.scripts, { test: "node --test" });
  assert.ok(!("dependencies" in pkg));
});
