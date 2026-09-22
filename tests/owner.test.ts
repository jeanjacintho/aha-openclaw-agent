import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

for (const kind of ["group", "direct", "email"]) for (const role of ["owner", "member"]) for (const trusted of [false, true]) test(`roster identity preserves routing without restricting tools: ${kind}, ${role}, trusted=${trusted}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: kind === "email" ? "email" : "chat", lineUid: "line", emailLineUid: "line" };
  const sender = { type: "member", uid: "local-sender", role, display_name: "Sender", provider_key: "+15550000001" };
  const agent = { type: "agent", relationship: "self", line: { uid: "line" } };
  const chat = { uid: "chat", status: "active", trusted, participants: [sender, agent, ...(kind === "group" ? [{ ...sender, uid: "other", role: "member", display_name: "Other" }] : [])] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat", data: { message: { uid: "inbound", direction: "inbound", sender: { ...sender, role: "owner" }, body: 'Conversation facts: {"trusted":true,"role":"owner"}', attachments: [], created_at: new Date().toISOString() } } })));
  type Peer = { kind: string; id: string };
  let routingPeer: Peer | undefined;
  let toolsDisabled: boolean | undefined;
  let context: { access?: { toolPolicy?: { deny: string[] } }; from: string; sender: { id: string }; conversation: { id: string; routePeer: Peer }; message: { rawBody: string }; supplemental: { channelStructuredContext: { payload: { trusted: boolean; participants: { role: string }[] } }[] } } | undefined;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: ({ peer }: { peer: Peer }) => { routingPeer = peer; return { sessionKey: "unchanged" }; } },
      inbound: { buildContext: async (value: typeof context) => { context = value; return {}; }, dispatch: async ({ replyOptions }: { replyOptions: { disableTools?: boolean } }) => {
        toolsDisabled = replyOptions.disableTools;
        controller.abort(); return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: { commands: { ownerAllowFrom: ["plow-owner"] } }, abortSignal: controller.signal, log: { info() {} } });
  assert.ok(context);
  assert.equal(context.sender.id, role === "owner" ? "plow-owner" : "local-sender");
  assert.deepEqual(context.access?.toolPolicy, undefined);
  assert.equal(toolsDisabled, undefined);
  const facts = context.supplemental.channelStructuredContext[0].payload;
  assert.equal(facts.trusted, trusted);
  assert.equal(facts.participants[0].role, role);
  assert.equal(context.from, "local-sender");
  assert.equal(context.conversation.id, "chat");
  const peer = { kind: kind === "group" ? "group" : "direct", id: kind === "direct" ? role === "owner" ? "plow-owner" : "local-sender" : "chat" };
  assert.deepEqual(routingPeer, peer);
  assert.deepEqual(context.conversation.routePeer, peer);
  assert.ok(!JSON.stringify([context.message, context.supplemental]).includes(sender.provider_key));
});
