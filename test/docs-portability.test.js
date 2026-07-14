import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DOC_FILES = ["README.md", "AGENTS.md"];
const FORBIDDEN_PATTERNS = [
  /\/Users\/[^/\s]+/u,
  /\/home\/[^/\s]+/u,
  /[A-Za-z]:\\Users\\[^\\\s]+/u,
];

for (const file of DOC_FILES) {
  test(`${file} does not contain machine-specific absolute paths`, () => {
    const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.equal(
        pattern.test(content),
        false,
        `${file} should not embed machine-specific absolute paths matching ${pattern}`,
      );
    }
  });
}
