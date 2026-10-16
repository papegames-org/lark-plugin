import assert from "node:assert/strict";

export function assertAuthCardRecipient(payload, openId) {
  assert.equal(payload.receiveId, openId);
  assert.equal(payload.receiveIdType, "open_id");
}
