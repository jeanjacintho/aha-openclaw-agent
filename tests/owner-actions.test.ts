import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import entry from "../plugin/index.ts";

const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");

for (const action of ["pending", "thread-cache", "thread-roster", "owner-send"]) test(`owner action with truncated listing: ${action}`, async t => {
  const root = await mkdtemp("/tmp/plow-owner-action-");
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "fixture-token";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const guest = { ...owner, uid: "guest", role: "member", provider_key: "+15550000002" };
  const self = { type: "agent", relationship: "self", line: { uid: "line" } };
  const home = { uid: "home", status: "active", trusted: true, participants: [self, owner] };
  const group = { ...home, uid: "group", participants: [self, guest, action === "thread-roster" ? owner : { ...guest, uid: "another" }] };
  const pending = { uid: "pending", direction: "inbound", sender: owner, body: "17 + 25?", attachments: [], created_at: new Date().toISOString() };
  let firstContact: boolean | undefined;
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let listings = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && ["/v1/chats", "/v1/chats/home/messages"].includes(request.url!)) {
      let body = "";
      for await (const chunk of request) body += chunk;
      posts.push({ path: request.url!, body: JSON.parse(body) });
      response.end(JSON.stringify({ uid: "sent" }));
    } else if (request.url === "/v1/chats") {
      listings++;
      response.end(JSON.stringify({ data: action === "thread-roster" ? [group] : [home, group], has_more: true }));
    } else response.end(JSON.stringify(request.url === "/v1/chats/group" ? group : request.url === "/v1/chats/home" ? home :
      request.url!.includes("/messages?") ? { data: action === "pending" && request.url!.includes("/home/") && !request.url!.includes("limit=20") ? [pending] : [], has_more: false } : { ticket: "ticket" }));
  });
  const sockets = new WebSocketServer({ server });
  if (action !== "pending") sockets.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "request", chat_id: "group", data: { message: {
      uid: "request", direction: "inbound", sender: guest, body: "Please send it", attachments: [], created_at: new Date().toISOString(),
    } },
  })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    clearTimeout(timeout); controller.abort();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const account = { apiBase: `http://127.0.0.1:${address.port}`, lineUid: "line", accountId: "chat" };
  const cfg = { channels: { plow: account } };
  let channel: { gateway: { startAccount: (context: object) => Promise<void> }; outbound: { sendText: (context: object) => Promise<unknown> } };
  let tool: { execute: (id: string, args: object) => Promise<unknown> };
  let failure: unknown;
  entry.register({ registrationMode: "full", logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    registerTool(factory: (context: object) => typeof tool) { tool = factory({ config: cfg }); },
    runtime: { channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "group" }) }, inbound: {
      buildContext: async (context: { supplemental: { channelStructuredContext: { payload: { first_contact: boolean } }[] } }) => {
        firstContact = context.supplemental.channelStructuredContext[0].payload.first_contact; return {};
      },
      dispatch: async ({ replyOptions, delivery }: { replyOptions: { onAgentRunTerminalOutcome: (value: string) => void }; delivery: { deliver: (payload: { text: string }) => Promise<unknown> } }) => {
        try {
          if (action === "pending") await delivery.deliver({ text: "42" });
          else if (action === "owner-send") await channel.outbound.sendText({ cfg, accountId: "chat", to: "plow-owner", text: "Ready" });
          else await tool.execute("call", { members: [guest.provider_key], body: "Ready" });
          replyOptions.onAgentRunTerminalOutcome("completed");
        } catch (error) { failure = error; }
        finally { controller.abort(); }
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      },
    } } },
  });
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal });
  assert.equal(failure, undefined);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, ["pending", "owner-send"].includes(action) ? "/v1/chats/home/messages" : "/v1/chats");
  assert.equal(posts[0].body.body, action === "pending" ? "42" : "Ready");
  if (action === "pending") assert.equal(firstContact, true);
  if (action.startsWith("thread")) assert.deepEqual(posts[0].body.members, [owner.provider_key, guest.provider_key]);
  assert.equal(listings, 1, "actions use discovered facts instead of listing again");
  t.diagnostic(`HTTP received ${posts[0].path}: ${JSON.stringify(posts[0].body)}`);
});
