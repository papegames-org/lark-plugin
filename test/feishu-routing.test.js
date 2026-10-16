import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cachedAccountBySession,
  cachedAgentBySession,
  getAccountId,
  listConfiguredFeishuAccountIds,
  lookupAccountIdByAgentConvention,
  lookupAgentIdByWorkspace,
  resolveAgentId,
  setApiConfigRef,
} from "../utils.js";

const sampleConfig = {
  agents: {
    list: [
      { id: "main", workspace: "/ws/main" },
      { id: "a-sub-bot", workspace: "/ws/sub" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "feishu", accountId: "default" } },
    { agentId: "a-sub-bot", match: { channel: "feishu", accountId: "a-sub-bot" } },
  ],
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

describe("feishu routing helpers", () => {
  it("lists configured accounts ignoring empty default placeholder when root has creds", () => {
    const feishuCfg = sampleConfig.channels.feishu;
    const ids = listConfiguredFeishuAccountIds(feishuCfg, feishuCfg.accounts);
    assert.deepEqual(ids.sort(), ["a-sub-bot", "default"].sort());
  });

  it("resolves agentId from workspace path", () => {
    setApiConfigRef(sampleConfig);
    assert.equal(lookupAgentIdByWorkspace("/ws/sub"), "a-sub-bot");
    assert.equal(lookupAgentIdByWorkspace("/ws/main"), "main");
  });

  it("maps agentId to account via bindings and convention", () => {
    setApiConfigRef(sampleConfig);
    cachedAccountBySession.clear();
    cachedAgentBySession.clear();

    const subCtx = { agentId: "a-sub-bot", channel: "feishu" };
    assert.equal(getAccountId(subCtx), "a-sub-bot");
    assert.equal(lookupAccountIdByAgentConvention(subCtx), "a-sub-bot");

    const mainCtx = { agentId: "main", channel: "feishu" };
    assert.equal(getAccountId(mainCtx), "default");
    assert.equal(lookupAccountIdByAgentConvention(mainCtx), "default");
  });

  it("restores agentId and accountId from session cache on later hooks", () => {
    setApiConfigRef(sampleConfig);
    cachedAccountBySession.clear();
    cachedAgentBySession.clear();

    cachedAgentBySession.set("sess-1", "a-sub-bot");
    cachedAccountBySession.set("sess-1", "a-sub-bot");

    const toolCtx = { sessionKey: "sess-1", channel: "feishu" };
    assert.equal(resolveAgentId(toolCtx), "a-sub-bot");
    assert.equal(getAccountId(toolCtx), "a-sub-bot");
  });

  it("infers main default account from workspace when agentId was cached", () => {
    setApiConfigRef(sampleConfig);
    cachedAccountBySession.clear();
    cachedAgentBySession.clear();
    cachedAgentBySession.set("sess-main", "main");

    const toolCtx = { sessionKey: "sess-main", channel: "feishu" };
    assert.equal(getAccountId(toolCtx), "default");
  });
});
