import test from "node:test";
import assert from "node:assert/strict";
import { readLarkAuthFromContent } from "../parse-meta.js";
import { buildScopeGrantLoginPayload, filterScopesNeedingUserGrant } from "../utils.js";

const IM_APP_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_msg",
  "im:message:send_as_bot",
  "im:chat:create",
];

test("readLarkAuthFromContent maps appScopes to scopeInstallGrant app", () => {
  const content = `---
name: demo
larkAuth:
  identity: user
  appScopes:
    - im:message:send_as_bot
  userScopes:
    - contact:user.base:readonly
---
`;
  const auth = readLarkAuthFromContent(content);
  assert.equal(auth.scopeInstallGrant["im:message:send_as_bot"], "app");
  assert.equal(auth.scopeInstallGrant["contact:user.base:readonly"], "user");
  assert.ok(auth.scopes.includes("im:message:send_as_bot"));
  assert.ok(auth.scopes.includes("contact:user.base:readonly"));
});

test("filterScopesNeedingUserGrant excludes scopeInstallGrant app even when API lists user identity", () => {
  const appScopeEntries = IM_APP_SCOPES.map((scope) => ({ scope, identity: "user" }));
  const scopeInstallGrant = Object.fromEntries(IM_APP_SCOPES.map((scope) => [scope, "app"]));
  const filtered = filterScopesNeedingUserGrant(
    [...IM_APP_SCOPES, "contact:user.base:readonly"],
    appScopeEntries,
    { scopeInstallGrant },
  );
  assert.deepEqual(filtered, ["contact:user.base:readonly"]);
});

test("filterScopesNeedingUserGrant keeps unknown scopes without install grant metadata", () => {
  const filtered = filterScopesNeedingUserGrant(["im:message"], []);
  assert.deepEqual(filtered, ["im:message"]);
});

test("buildScopeGrantLoginPayload uses app-only tenant grant when IM is appScopes", () => {
  const scopeInstallGrant = Object.fromEntries(IM_APP_SCOPES.map((scope) => [scope, "app"]));
  const grant = buildScopeGrantLoginPayload(IM_APP_SCOPES, {
    identity: "user",
    authReason: "app_scope",
    requiredScopes: IM_APP_SCOPES,
    scopeInstallGrant,
    appScopeEntries: IM_APP_SCOPES.map((scope) => ({ scope, identity: "user" })),
  });
  assert.equal(grant.scopeGrantDual, false);
  assert.equal(grant.tenantScopes?.length, IM_APP_SCOPES.length);
  assert.equal(grant.userScopes, null);
});

test("buildScopeGrantLoginPayload does not dual grant when authReason is user_grant", () => {
  const scope = "im:chat:readonly";
  const appScopeEntries = [
    { scope, identity: "app" },
    { scope, identity: "user" },
  ];
  const grant = buildScopeGrantLoginPayload([scope], {
    identity: "user",
    authReason: "user_grant",
    requiredScopes: [scope],
    appScopeEntries,
  });
  assert.equal(grant.scopeGrantDual, false);
  assert.equal(grant.tenantScopes, null);
  assert.equal(grant.userScopes, null);
});
