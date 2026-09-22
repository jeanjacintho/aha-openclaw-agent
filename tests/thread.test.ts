import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Tool = { name: string; execute: (id: string, args: object) => Promise<unknown> };

for (const toolName of ["plow_start_thread", "message"]) {
  for (const status of [200, 403, 408, 424, 503, "network"] as const) test(`${toolName}: per-turn delivery state, status=${status}`, async t => {
    const { server, apiBase, abortAfter } = await websocketFixture(t);
    const controller = abortAfter();
    const account = { apiBase, accountId: "chat", lineUid: "line" };
    const cfg = { channels: { plow: account }, commands: { ownerAllowFrom: ["owner"] } };
    const sender = { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" };
    const chat = { uid: "home", status: "active", participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
    const posts: Record<string, unknown>[] = [];
    const results: unknown[] = [], errors: string[] = [], logs: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      if (options.method === "POST" && (url.endsWith("/chats") || url.endsWith("/messages"))) {
        posts.push(JSON.parse(options.body as string));
        if (status === "network") throw new TypeError("network error");
        return Response.json({ uid: "created" }, { status });
      }
      return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
        url.endsWith("/chats/home") || url.endsWith("/chats/target") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
    });
    server.on("connection", (socket: { send: (text: string) => void }) => {
      for (const uid of ["first-request", "later-identical-request"]) socket.send(JSON.stringify({
        event_type: "message_received", event_id: uid, chat_id: "home",
        data: { message: { uid, direction: "inbound", sender, body: "Start a group", attachments: [], created_at: new Date().toISOString() } },
      }));
    });
    let channel: { outbound: { sendText: (context: object) => Promise<unknown> }; gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
    let tool: Tool;
    let turns = 0;
    entry.register({ registrationMode: "full", logger: { info() {} }, on() {},
      registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
      registerTool(factory: (context: object) => Tool) { const candidate = factory({ config: cfg }); if (candidate.name === toolName) tool = candidate; },
      runtime: { channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) }, inbound: {
        buildContext: async () => ({}), dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
          for (let retry = 0; retry < 4; retry++) {
            try { results.push(await (toolName === "message" ? channel!.outbound.sendText({ cfg, accountId: "chat", to: "target", text: "Meet Friday?" }) : tool.execute(`call-${retry}`, { members: retry === 3 ? ["+15550000003"] : retry === 1 ? ["+15550000001", "+15550000002"] : ["+15550000002", "+15550000001"], chat_uid: "home", body: retry === 2 ? "Meet Saturday?" : "Meet Friday?" }))); }
            catch (error) { errors.push((error as Error).message); }
          }
          replyOptions.onAgentRunTerminalOutcome("completed");
          if (++turns === 2) controller.abort();
          if (status === 503) throw new Error("dispatch failed after uncertain delivery");
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      } } },
    });
    await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(text: string) { logs.push(text); } } });
    assert.equal(turns, 2);
    assert.equal(posts.length, status === 200 || status === 403 ? 8 : 2);
    if (status === 200) {
      assert.equal(results.length, 8);
      if (toolName === "plow_start_thread") {
        assert.deepEqual(posts[0].members, ["+15550000001", "+15550000002"]);
        assert.equal(posts[0].trusted, true);
        assert.equal(posts[0].line_uid, "line");
        assert.equal(posts[0].body, "Meet Friday?");
        assert.equal(posts[0].idempotency_key, posts[1].idempotency_key);
        assert.equal(posts[4].idempotency_key, posts[5].idempotency_key);
        assert.equal(new Set(posts.map(post => post.idempotency_key)).size, 6);
        assert.deepEqual((results[0] as { details: unknown }).details, { chat_uid: "created", message_sent: true });
      }
    } else {
      assert.equal(results.length, 0);
      assert.equal(errors.length, 8);
      assert.ok(errors.every(error => status === 403 ? error.includes("HTTP 403") : error.includes("delivery is unknown")));
      if (status !== 403) for (const uid of ["first-request", "later-identical-request"])
        assert.ok(logs.some(text => text.startsWith(`turn failed chat=home message=${uid}: delivery unknown`)));
    }
  });
}
