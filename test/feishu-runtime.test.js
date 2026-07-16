import test from "node:test";
import assert from "node:assert/strict";

import {
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
