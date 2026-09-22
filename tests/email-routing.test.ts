import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";
import { websocketFixture } from "./ws-fixture.ts";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { resolveAgentRoute } = await import(require.resolve("openclaw/plugin-sdk/routing"));

test("native routing isolates email threads and shares one thread across senders", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const sender = (uid: string) => ({ type: "member", uid, display_name: uid, role: "member" });
  const chat = (uid: string) => ({ uid, status: "active", trusted: false, participants: [
    { type: "agent", relationship: "self", line: { uid: "mail" } }, sender("alice"), sender("bob"),
  ] });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [], has_more: false } : url.includes("/messages?") ? { data: [], has_more: false } :
    url.includes("/chats/") ? chat(url.split("/").at(-1)!) : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const [i, [thread, author]] of [["thread-a", "alice"], ["thread-b", "alice"], ["thread-a", "bob"]].entries()) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: String(i), chat_id: thread, data: { message: {
        uid: String(i), direction: "inbound", sender: sender(author), body: "hello", attachments: [], created_at: new Date().toISOString(),
      } } }));
    }
  });
  const sessions: string[] = [];
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } };
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute },
      inbound: {
        buildContext: async (context: { route: { routeSessionKey: string } }) => { sessions.push(context.route.routeSessionKey); return {}; },
        dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
          replyOptions.onAgentRunTerminalOutcome("completed");
          if (sessions.length === 3) controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  await channel!.gateway.startAccount({
    account: { apiBase, accountId: "email", lineUid: "ln_probe", emailLineUid: "mail" },
    cfg: renderConfig(probeIdentity, apiBase), abortSignal: controller.signal,
  });
  assert.equal(sessions.length, 3);
  assert.notEqual(sessions[0], sessions[1], "one sender in different threads must have separate sessions");
  assert.equal(sessions[0], sessions[2], "different senders in one thread must share the session");
});
