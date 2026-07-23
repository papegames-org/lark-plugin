import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUserOAuthAuthorizationUrl,
  resolveFeishuBrand,
  resolveOpenApiBaseUrl,
} from "../feishu-runtime.js";

test("resolveFeishuBrand accepts short brand tokens", () => {
  assert.equal(resolveFeishuBrand("lark"), "lark");
  assert.equal(resolveFeishuBrand("feishu"), "feishu");
});

test("resolveOpenApiBaseUrl ignores invalid short feishu domain tokens", () => {
  assert.equal(
    resolveOpenApiBaseUrl({ brand: "feishu", domain: "feishu" }),
    "https://open.feishu.cn",
  );
});

test("resolveOpenApiBaseUrl ignores invalid short lark domain tokens", () => {
  assert.equal(
    resolveOpenApiBaseUrl({ brand: "lark", domain: "lark" }),
    "https://open.larksuite.com",
  );
});

test("resolveOpenApiBaseUrl accepts full Feishu origins and rewrites accounts host", () => {
  assert.equal(
    resolveOpenApiBaseUrl({ brand: "feishu", domain: "open.feishu.cn" }),
    "https://open.feishu.cn",
  );
  assert.equal(
    resolveOpenApiBaseUrl({ brand: "feishu", domain: "https://accounts.feishu.cn" }),
    "https://open.feishu.cn",
  );
});

test("buildUserOAuthAuthorizationUrl builds a real user OAuth authorization URL", () => {
  const url = new URL(buildUserOAuthAuthorizationUrl({
    appId: "cli_test",
    brand: "feishu",
    redirectUri: "https://example.com/oauth/callback",
    scopes: ["base:app:create", "base:app:update"],
    state: "state_123",
  }));

  assert.equal(url.origin, "https://accounts.feishu.cn");
  assert.equal(url.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(url.searchParams.get("client_id"), "cli_test");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/oauth/callback");
  assert.equal(url.searchParams.get("scope"), "base:app:create base:app:update offline_access");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "state_123");
});
