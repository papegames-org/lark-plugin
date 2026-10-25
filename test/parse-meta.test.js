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
    scopeInstallGrant: {},
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
    scopeInstallGrant: {},
  });
});

test("readLarkAuthFromContent ignores Feishu user open_id values in scope lists", () => {
  const content = `---
larkAuth:
  identity: user
  scopes:
    - im:message
    - user:ou_4fc048c59c4820feda9d591cd213b480
    - ou_4fc048c59c4820feda9d591cd213b480
    - contact:user.base:readonly
  user: ou_4fc048c59c4820feda9d591cd213b480
  userScopes:
    - "user:ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
---
`;

  assert.deepEqual(readLarkAuthFromContent(content), {
    identity: "user",
    scopes: ["im:message", "contact:user.base:readonly"],
    scopeInstallGrant: {},
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

test("readLarkAuthFromContent preserves dual install grants for one scope", () => {
  const content = `---
larkAuth:
  identity: user
  appScopes:
    - docs:doc
  userScopes:
    - docs:doc
---
# Demo
`;

  assert.deepEqual(readLarkAuthFromContent(content), {
    identity: "user",
    scopes: ["docs:doc"],
    scopeInstallGrant: { "docs:doc": "user" },
    scopeInstallGrants: { "docs:doc": ["app", "user"] },
  });
});
