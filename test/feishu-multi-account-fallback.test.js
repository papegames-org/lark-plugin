import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAccountCredentials,
  resolveMultiAccountFallbackAccountId,
  setApiConfigRef,
  setPluginConfigRef,
} from "../utils.js";

const multiAccountConfig = {
  channels: {
    feishu: {
      appId: "cli_main",
      appSecret: "sec_main",
      accounts: {
        default: {},
        "a-sub-bot": { appId: "cli_sub", appSecret: "sec_sub" },
      },
    },
  },
};

describe("multi-account fallback", () => {
  it("implicit default for empty ctx when accounts.default exists", () => {
    setApiConfigRef(multiAccountConfig);
    setPluginConfigRef({});
    const hit = resolveMultiAccountFallbackAccountId({}, ["default", "a-sub-bot"]);
    assert.equal(hit?.accountId, "default");
    assert.equal(hit?.source, "implicit-main-default");
  });

  it("prefers plugin config defaultFeishuAccountId over implicit default", () => {
    setApiConfigRef(multiAccountConfig);
    setPluginConfigRef({ defaultFeishuAccountId: "a-sub-bot" });
    const hit = resolveMultiAccountFallbackAccountId({}, ["default", "a-sub-bot"]);
    assert.equal(hit?.accountId, "a-sub-bot");
    assert.equal(hit?.source, "plugin-config");
  });

  it("does not implicit-default for non-main agent without routing", () => {
    setApiConfigRef(multiAccountConfig);
    setPluginConfigRef({});
    const hit = resolveMultiAccountFallbackAccountId(
      { agentId: "legal-assistant" },
      ["default", "a-sub-bot"],
    );
    assert.equal(hit, null);
  });

  it("getAccountCredentials resolves implicit default on sparse ctx", async () => {
    setApiConfigRef(multiAccountConfig);
    setPluginConfigRef({});
    const creds = await getAccountCredentials({});
    assert.equal(creds.accountId, "default");
    assert.equal(creds.appId, "cli_main");
  });

  it("getAccountCredentials rejects sub-agent without account routing", async () => {
    setApiConfigRef(multiAccountConfig);
    setPluginConfigRef({});
    await assert.rejects(
      () => getAccountCredentials({ agentId: "legal-assistant" }),
      /feishu account unresolved/,
    );
  });
});
