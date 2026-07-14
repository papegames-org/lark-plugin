import test from "node:test";
import assert from "node:assert/strict";

import { readLarkAuthFromContent } from "../parse-meta.js";

test("readLarkAuthFromContent parses metadata JSON larkAuth", () => {
  const content = `---
name: demo
metadata: { "openclaw": { "larkAuth": { "identity": "user", "scopes": ["im:message", "contact:user.base:readonly"] } } }
---
# Demo
`;

  assert.deepEqual(readLarkAuthFromContent(content), {
    identity: "user",
    scopes: ["im:message", "contact:user.base:readonly"],
  });
});

test("readLarkAuthFromContent parses nested YAML larkAuth under metadata", () => {
  const content = `---
name: demo
metadata:
  openclaw:
    larkAuth:
      identity: user
      scopes:
        - im:message
        - im:message
        - contact:user.base:readonly
---
# Demo
`;

  assert.deepEqual(readLarkAuthFromContent(content), {
    identity: "user",
    scopes: ["im:message", "contact:user.base:readonly"],
  });
});

test("readLarkAuthFromContent returns null when scopes are empty", () => {
  const content = `---
larkAuth:
  identity: user
  scopes: []
---
`;

  assert.equal(readLarkAuthFromContent(content), null);
});
