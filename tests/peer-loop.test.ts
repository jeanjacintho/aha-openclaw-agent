import assert from "node:assert/strict";
import { test } from "node:test";
import { createPeerLoopGuard, MAX_CONSECUTIVE_PEER_TURNS } from "../plugin/peer-loop.ts";

const peer = { type: "agent", relationship: "peer" };
const member = { type: "member" };

test("peer loop guard suppresses turns after the consecutive limit", () => {
  const guard = createPeerLoopGuard();
  const logs: string[] = [];
  const log = (text: string) => logs.push(text);

  for (let i = 0; i < MAX_CONSECUTIVE_PEER_TURNS; i += 1) assert.equal(guard("chat-a", peer, log), false);
  assert.equal(guard("chat-a", peer, log), true);
  assert.equal(guard("chat-a", peer, log), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /chat-a/);
});

test("a human message resets the peer limit and is never suppressed", () => {
  const guard = createPeerLoopGuard();
  const log = () => {};
  for (let i = 0; i < MAX_CONSECUTIVE_PEER_TURNS + 2; i += 1) guard("chat-a", peer, log);

  assert.equal(guard("chat-a", member, log), false);
  assert.equal(guard("chat-a", peer, log), false);
  for (let i = 0; i < 10; i += 1) assert.equal(guard("chat-a", member, log), false);
});

test("peer turn counts are independent for each chat", () => {
  const guard = createPeerLoopGuard();
  const log = () => {};
  for (let i = 0; i < MAX_CONSECUTIVE_PEER_TURNS; i += 1) assert.equal(guard("chat-a", peer, log), false);

  assert.equal(guard("chat-b", peer, log), false);
  assert.equal(guard("chat-a", peer, log), true);
  assert.equal(guard("chat-b", peer, log), false);
});
