import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { websocketFixture } from "./ws-fixture.ts";
import fs, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { listen, DeliveryUnknownError, recover, findOwnerChat, ownerChat, type Account, type Chat, type Message } from "../plugin/transport.ts";

const account = { apiBase: "http://fixture", accountId: "chat" } as Account;
const message = (uid: string) => ({ uid }) as Message;
const acceptedChat = (uid: string) => ({
  uid, status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }],
});
const inbound = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" } });

test("recovery walks older pages to the checkpoint and replays oldest first", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(url.includes("starting_after=newer")
      ? { data: [message("missed"), message("acked"), message("old")], has_more: true }
      : { data: [message("newest"), message("newer")], has_more: true });
  });
  assert.deepEqual((await recover(account, "chat", "acked")).map(m => m.uid), ["missed", "newer", "newest"]);
  assert.deepEqual(urls, ["http://fixture/v1/chats/chat/messages?limit=50", "http://fixture/v1/chats/chat/messages?limit=50&starting_after=newer"]);
});

test("empty first-install checkpoint still recovers the first missed message", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [message("first")], has_more: false }));
  assert.deepEqual((await recover(account, "chat", "")).map(m => m.uid), ["first"]);
});

test("a failed history read cannot masquerade as an empty recovery", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(recover(account, "chat", "acked"), /HTTP 503/);
});

test("a truncated chat listing warns and keeps recovery and live delivery on the same connection", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/group`, "old");
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const missed = { uid: "missed", direction: "inbound", sender: { type: "member" } };
  let connections = 0;
  let liveSent = false;
  server.on("connection", () => { connections++; });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: true } :
    url.endsWith("/chats/group") ? chat :
    url.endsWith("/messages?limit=50") ? { data: [...(liveSent ? [{ ...missed, uid: "live" }] : []), missed, { uid: "old" }], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const received: string[] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => logs.push(text), async (_chat, message) => {
    received.push(message.uid);
    if (message.uid === "missed") {
      liveSent = true;
      for (const socket of server.clients) socket.send(JSON.stringify({
        event_type: "message_received", event_id: "live", chat_id: chat.uid, data: { message: { ...missed, uid: "live" } },
      }));
    } else controller.abort();
    return "completed";
  });
  assert.deepEqual(received, ["missed", "live"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), "live");
  assert.equal(connections, 1);
  assert.ok(logs.some(text => text.includes("warning") && text.includes("truncated")));
  assert.ok(!logs.some(text => text.startsWith("transport stopped:")));
});

for (const owner of [false, true]) test(`a frame arriving while a synthesized checkpoint is written is recovered: owner=${owner}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }, ...(owner ? [{ type: "member", uid: "owner", role: "owner" }] : [])] };
  const message = { uid: "arriving", direction: "inbound", sender: { type: "member" } };
  const baseline = owner ? { ...message, uid: "pending" } : message;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
    url.includes("/messages?") ? { data: injected && owner ? [message, baseline] : [baseline], has_more: false } : { ticket: "ticket" }));
  const originalWrite = fs.writeFile;
  let injected = false;
  const writer = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!injected && String(args[0]).endsWith("/group.tmp") && args[1] === (owner ? `first:${baseline.uid}` : baseline.uid)) {
      injected = true;
      for (const socket of server.clients) {
        socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: chat.uid, data: { message } }));
        await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
      }
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    if (message.uid === "arriving") controller.abort();
    return "completed";
  });
  assert.equal(injected, true);
  assert.deepEqual(received, owner ? ["pending", "arriving"] : ["arriving"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), message.uid);
});

test("recovery beyond the seen cache does not replay buffered frames or rewind the checkpoint", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/group`, "old");
  const controller = abortAfter(30_000);
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  let historyReads = 0;
  const messages = Array.from({ length: 514 }, (_, i) => ({ uid: `message-${i}`, direction: "inbound", sender: { type: "member" } }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/messages?")) for (const socket of server.clients) {
      for (const message of [messages[0], { ...messages[0], uid: "live" }]) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
      await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
      url.includes("/messages?") ? { data: [...(++historyReads > 1 ? [{ ...messages[0], uid: "live" }] : []), ...[...messages].reverse()], has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    if (message.uid === "live") {
      assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), messages.at(-1)!.uid);
      controller.abort();
    }
    received.push(message.uid);
    return "completed";
  });
  const deadlineFired = controller.signal.reason?.name === "TimeoutError";
  assert.equal(deadlineFired, false, "514-message recovery exceeded its 30,000 ms deadline");
  assert.deepEqual(received, [...messages.map(message => message.uid), "live"]);
});

for (const outcome of ["completed", "incomplete"] as const) test(`unknown delivery advances once; next turn ${outcome} during abort`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const fixture = { ...account, apiBase, lineUid: "line" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const uid of ["uncertain", "next"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: "chat", data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const calls: string[] = [];
  await listen(fixture, controller.signal, () => {}, async (_chat, message) => {
    calls.push(message.uid);
    if (message.uid === "uncertain") throw new DeliveryUnknownError();
    controller.abort();
    return outcome;
  });
  assert.deepEqual(calls, ["uncertain", "next"]);
  assert.equal(fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).length, 0, "unknown delivery never sends another message");
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), outcome === "completed" ? "next" : "uncertain");
});

for (const scenario of ["waited", "pending", "buffered", "buffered-before-read", "buffered-after-read", "two-during-baseline", "two-during-history", "unanswered-before-connect", "newer-during-baseline", "interrupted", "answered", "peer", "group", "fresh"]) test(`first contact and restart: ${scenario}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  if (scenario === "waited") {
    await mkdir(`${root}/plow-checkpoints`);
    await writeFile(`${root}/plow-checkpoints/home`, "");
  }
  const fixture = { ...account, apiBase, lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const chat = { uid: "home", status: "active", participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }, ...(scenario === "group" ? [{ ...sender, uid: "guest", role: "member" }] : [])] };
  const first = { uid: "first", body: "What is 17 + 25?", direction: scenario === "answered" ? "outbound" : "inbound",
    sender: scenario === "peer" ? { type: "agent", relationship: "peer", line: { uid: "peer" } } : sender };
  const older = { ...first, uid: "older", direction: "outbound" };
  const newer = { ...first, uid: "newer" };
  const twoMessages = ["buffered-before-read", "buffered-after-read", "two-during-baseline", "two-during-history", "unanswered-before-connect", "newer-during-baseline"].includes(scenario);
  let boot = 0;
  if (["buffered", "fresh", "interrupted"].includes(scenario)) server.on("connection", (socket: { send: (text: string) => void }) => {
    if (scenario !== "interrupted" || !boot) socket.send(JSON.stringify({ event_type: "message_received", event_id: "first", chat_id: "home", data: { message: first } }));
  });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (!boot && (((scenario === "buffered-before-read" || scenario === "newer-during-baseline") && url.endsWith("/chats")) ||
      (scenario === "buffered-after-read" && url.includes("limit=1")) ||
      (scenario === "two-during-baseline" && url.includes("limit=1")) ||
      (scenario === "two-during-history" && url.includes("limit=20")))) {
      for (const socket of server.clients) {
        for (const message of ["buffered-after-read", "newer-during-baseline"].includes(scenario) ? [newer] : [first, newer]) {
          socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: "home", data: { message } }));
        }
        // A pong confirms the client has processed the preceding frames.
        const pong = once(socket, "pong");
        socket.ping();
        await pong;
      }
    }
    return Response.json(
      url.endsWith("/chats") ? { data: scenario === "fresh" || (scenario === "interrupted" && !boot) ? [] : [chat], has_more: false } :
      url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? {
        data: url.includes("limit=1") ? [["buffered-before-read", "two-during-baseline", "unanswered-before-connect", "newer-during-baseline"].includes(scenario) ? newer : first] :
          scenario === "waited" ? [first] : twoMessages ? [newer, first, older] : [first, older], has_more: false,
      } : { ticket: "ticket" });
  });
  const turns: { uid: string; firstContact: boolean }[] = [];
  for (; boot < 2; boot++) {
    const controller = abortAfter();
    await listen(fixture, controller.signal, () => {}, async (_chat, message, firstContact) => {
      turns.push({ uid: message.uid, firstContact });
      if (scenario === "interrupted") { controller.abort(); return boot ? "completed" : "incomplete"; }
      return "completed";
    });
    assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), scenario === "interrupted" && !boot ? "first:first" : twoMessages ? "newer" : "first");
  }
  assert.deepEqual(turns, scenario === "interrupted" ? [{ uid: "first", firstContact: true }, { uid: "first", firstContact: true }] : twoMessages ? [{ uid: "first", firstContact: true }, { uid: "newer", firstContact: false }] : ["waited", "pending", "buffered", "fresh"].includes(scenario) ? [{ uid: "first", firstContact: true }] : []);
});

test("first-contact recovery includes its message and newer arrivals, excluding older history", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [message("newer"), message("pending"), message("old")], has_more: false,
  }));
  assert.deepEqual((await recover(account, "home", "first:pending")).map(m => m.uid), ["pending", "newer"]);
});

for (const failure of ["incomplete", "throws", "notice-unknown"] as const) test(`a turn that ${failure} is acked without disconnecting or replaying later turns`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const fixture = { ...account, apiBase, lineUid: "line" };
  const chats = ["home", "other"].map(uid => ({ uid, status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
  ] }));
  const messages = ["unfinished", "later"].map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  let recovering = false;
  const notices: { url: string; body: string; checkpoint: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "POST" && url.endsWith("/messages")) {
      notices.push({ url, body: JSON.parse(options.body as string).body,
        checkpoint: await readFile(`${root}/plow-checkpoints/home`, "utf8") });
      if (failure === "notice-unknown") throw new TypeError("connection lost after sending notice");
      return Response.json({ uid: "notice" });
    }
    return Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: recovering && url.includes("/home/") ? [...messages].reverse() : [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" });
  });
  let connections = 0;
  server.on("connection", (socket: { send: (text: string) => void }) => {
    connections++;
    if (recovering) return;
    for (const [chat, message] of [["home", messages[0]], ["home", messages[1]], ["other", { ...messages[1], uid: "other-reply" }]] as const) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat, data: { message } }));
    }
  });
  for (const phase of ["live", "recovery"]) {
    recovering = phase === "recovery";
    const controller = abortAfter();
    const calls: string[] = [];
    const logs: string[] = [];
    const priorCheckpoints: string[] = [];
    await listen(fixture, controller.signal, text => {
      logs.push(text);
      if (text.startsWith("transport stopped") || (logs.includes("acked chat=home message=later") && logs.includes("acked chat=other message=other-reply"))) controller.abort();
    }, async (_chat, message) => {
      calls.push(message.uid);
      if (message.uid === "later") priorCheckpoints.push(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
      if (!recovering && message.uid === "unfinished") {
        if (failure === "throws") throw new Error("turn failed");
        return "incomplete";
      }
      if (recovering && message.uid === "later") controller.abort();
      return "completed";
    });
    assert.deepEqual([...calls].sort(), recovering ? [] : ["later", "other-reply", "unfinished"]);
    if (!recovering) assert.ok(calls.indexOf("unfinished") < calls.indexOf("later"));
    assert.deepEqual(priorCheckpoints, recovering ? [] : ["unfinished"]);
    assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), "later");
    assert.equal(await readFile(`${root}/plow-checkpoints/other`, "utf8"), "other-reply");
    assert.equal(connections, recovering ? 2 : 1);
    assert.equal(notices.length, 1, "one notice attempt, with no replay after restart or uncertain notice delivery");
    assert.equal(notices[0].checkpoint, "unfinished");
    assert.equal(notices[0].url, `${apiBase}/v1/chats/home/messages`);
    assert.match(notices[0].body, /part.*may have.*(?:happened|gone through)/i);
    assert.match(notices[0].body, /check before resending/i);
    assert.ok(!logs.some(text => text.startsWith("transport stopped")));
    if (!recovering) assert.ok(logs.some(text => text.includes("turn incomplete chat=home message=unfinished")));
  }
});

test("a new chat's message arriving during listing is buffered by the socket", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "new-chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) {
      for (const socket of server.clients) socket.send(JSON.stringify({
        event_type: "message_received", event_id: "new-event", chat_id: chat.uid,
        data: { message: { uid: "new-message", direction: "inbound", sender: { type: "member" } } },
      }));
      return Response.json({ data: [], has_more: false });
    }
    return Response.json(url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    controller.abort();
    return "completed";
  });
  assert.deepEqual(received, ["new-message"]);
});

for (const count of [1, 2]) for (const arrival of ["listing", "baseline"] as const) test(`${count} existing chat frames arriving during ${arrival} are delivered in order without replaying history`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const messages = ["old", "first", "second"].slice(0, count + 1).map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (arrival === "listing" ? url.endsWith("/chats") : url.includes("limit=1")) {
      for (const socket of server.clients) {
        for (const message of messages.slice(1)) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
        // Wait for a round trip so the frames reach the client before the snapshot.
        await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
      }
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?")
        ? { data: url.includes("limit=1") ? messages.slice(-1) : [...messages].reverse(), has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    if (received.length === count) controller.abort();
    return "completed";
  });
  assert.deepEqual(received, messages.slice(1).map(message => message.uid));
  assert.equal(await readFile(`${root}/plow-checkpoints/group`, "utf8"), messages.at(-1)!.uid);
});

test("an omitted checkpointed chat recovers before its first live frame advances progress", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/omitted`, "old");
  const chat = { uid: "omitted", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const incoming = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" } });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [], has_more: true } :
    url.endsWith("/chats/omitted") ? chat :
    url.includes("limit=50") ? { data: [incoming("live"), incoming("missed"), incoming("old")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "live-event", chat_id: chat.uid, data: { message: incoming("live") },
  })));
  const delivered: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    delivered.push(message.uid);
    if (message.uid === "live") controller.abort();
    return "completed";
  });
  assert.deepEqual(delivered, ["missed", "live"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/omitted`, "utf8"), "live");
});

test("optional history failure still dispatches the message with empty history", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const inbound = { uid: "inbound", direction: "inbound", sender: { type: "member" } };
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=20")) return ++historyReads === 1
      ? new Response(null, { status: 503 })
      : Response.json({ data: [inbound], has_more: false });
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "event", chat_id: chat.uid, data: { message: inbound },
  })));
  const delivered: string[] = [];
  const histories: Message[][] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("acked") && delivered.length === 2) controller.abort();
  }, async (_chat, message, _first, history) => {
    delivered.push(message.uid);
    histories.push(history);
    if (delivered.length === 1) for (const socket of server.clients) socket.send(JSON.stringify({
      event_type: "message_received", event_id: "second", chat_id: chat.uid, data: { message: { ...inbound, uid: "second" } },
    }));
    return "completed";
  });
  assert.deepEqual(delivered, ["inbound", "second"]);
  assert.equal(historyReads, 2);
  assert.deepEqual(histories, [[], [inbound]]);
  assert.ok(logs.some(text => text.includes("history") && text.includes("failed")));
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), "second");
});

test("reconnecting does not re-inject history into an already contextualized chat", { timeout: 40_000 }, async t => {
  const { server, apiBase } = await websocketFixture(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); });
  const chat = { uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  let historyReads = 0;
  let connections = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=20")) historyReads++;
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    const uid = String(++connections);
    socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat.uid,
      data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const delivered: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    delivered.push(message.uid);
    if (delivered.length === 1) for (const socket of server.clients) socket.close();
    else controller.abort();
    return "completed";
  });
  assert.deepEqual(delivered, ["1", "2"]);
  assert.equal(historyReads, 1);
});

test("owner discovery requires the unique active self-line DM with an owner", async t => {
  const fixture = { ...account, lineUid: "line" };
  const home: Chat = { uid: "home", status: "active", trusted: true, participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "owner", role: "owner", display_name: "Owner" },
  ] };
  const others: Chat[] = [
    { ...home, uid: "inactive", status: "inactive" },
    { ...home, uid: "group", participants: [...home.participants, home.participants[1]] },
    { ...home, uid: "email", participants: [{ type: "agent", relationship: "self", line: { uid: "email" } }, home.participants[1]] },
    { ...home, uid: "peer", participants: [{ type: "agent", relationship: "peer", line: { uid: "line" } }, home.participants[1]] },
    { ...home, uid: "member", participants: [home.participants[0], { type: "member", uid: "member", role: "member", display_name: "Member" }] },
  ];
  assert.equal(findOwnerChat(fixture, others), undefined);
  assert.equal(findOwnerChat(fixture, [...others, home]), home);
  assert.throws(() => findOwnerChat(fixture, [home, { ...home, uid: "second" }]), /found 2/);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [home], has_more: true }));
  await assert.rejects(ownerChat(fixture), /truncated/);
});

test("ambiguous owner chats stop until restart instead of repeatedly discovering them", async t => {
  const { apiBase } = await websocketFixture(t);
  const controller = new AbortController();
  const logs: string[] = [];
  const participants = [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "owner", role: "owner" },
  ];
  let tickets = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/ws/ticket")) { tickets++; return Response.json({ ticket: "ticket" }); }
    return Response.json({ data: ["first", "second"].map(uid => ({ uid, status: "active", participants })), has_more: false });
  });
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.includes("stopped")) queueMicrotask(() => controller.abort());
  }, async () => {
    assert.fail("Ambiguous owner chats must not dispatch");
  });
  assert.ok(logs.includes("Expected one owner's chat; found 2; stopped until restart"));
  assert.equal(tickets, 1);
});

test("a stalled WebSocket upgrade times out and reconnects after backoff", { timeout: 55_000 }, async t => {
  const { abortAfter } = await websocketFixture(t);
  const controller = abortAfter(50_000);
  const server = createServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let upgrades = 0;
  let firstClosed = false;
  const started = Date.now();
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    if (upgrades === 1) socket.on("end", () => { firstClosed = true; socket.end(); });
    else controller.abort();
    // Read EOF so the fixture observes the client aborting the pending upgrade.
    socket.resume();
    // Accept TCP, but deliberately never answer the HTTP upgrade.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address() as import("node:net").AddressInfo;
  t.mock.method(globalThis, "fetch", async () => Response.json({ ticket: "ticket" }));
  const logs: string[] = [];
  await listen({ ...account, apiBase: `http://127.0.0.1:${address.port}` }, controller.signal,
    text => logs.push(text), async () => assert.fail("An unopened socket cannot dispatch"));
  assert.equal(upgrades, 2, "must retry the stalled upgrade");
  assert.equal(firstClosed, true, "must abort the stalled connection");
  assert.ok(Date.now() - started >= 45_000, "15s handshake bound plus normal 30s backoff");
  assert.ok(logs.some(text => text.startsWith("transport stopped:")));
});

test("a buffered message preceding the HTTP baseline runs first without replay after restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const fixture = { ...account, apiBase, lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const chat = { uid: "home", status: "active", participants: [
    sender, { type: "agent", relationship: "self", line: { uid: "line" } },
  ] };
  // Equal timestamps still have a stable order in the API's history.
  const messages = ["X", "Y"].map(uid => ({
    uid, body: uid, direction: "inbound", sender, created_at: "2026-09-22T12:00:00Z",
  }));
  let boot = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if ((!boot && url.endsWith("limit=1")) || (boot && url.endsWith("/chats"))) {
      for (const socket of server.clients) {
        socket.send(JSON.stringify({ event_type: "message_received", event_id: `X-${boot}`,
          chat_id: chat.uid, data: { message: messages[0] } }));
        const pong = once(socket, "pong");
        socket.ping();
        await pong;
      }
    }
    if (url.endsWith("/chats")) return Response.json({ data: [chat], has_more: false });
    if (url.endsWith("/chats/home")) return Response.json(chat);
    if (url.includes("/messages?")) {
      const cursor = new URL(url).searchParams.get("starting_after");
      const newestFirst = [...messages].reverse();
      return Response.json({ data: url.endsWith("limit=1") ? [messages[1]] :
        cursor ? newestFirst.slice(newestFirst.findIndex(m => m.uid === cursor) + 1) : newestFirst,
        has_more: false });
    }
    return Response.json({ ticket: "ticket" });
  });
  const turns: string[] = [];
  for (; boot < 2; boot++) {
    await listen(fixture, abortAfter().signal, () => {}, async (_chat, message) => {
      turns.push(message.uid);
      return "completed";
    });
    assert.deepEqual(turns, ["X", "Y"], "buffered input precedes the newer HTTP baseline and neither replays on restart");
    assert.equal(await readFile(`${root}/plow-checkpoints/home`, "utf8"), "Y");
  }
});

for (const source of ["live", "recovery"] as const) test(`a fast chat replies during a slow ${source} turn, with ordered checkpoints`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chats = ["slow", "fast"].map(acceptedChat);
  await mkdir(`${root}/plow-checkpoints`);
  for (const chat of chats) await writeFile(`${root}/plow-checkpoints/${chat.uid}`, "old");
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("limit=50") ? { data: source === "recovery" ?
      (url.includes("/slow/") ? [inbound("second"), inbound("slow")] : [inbound("fast")]) : [], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const [chat, uid] of [["slow", "slow"], ["slow", "second"], ["fast", "fast"]]) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat, data: { message: inbound(uid) } }));
    }
  });
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => release.resolve());
  const replies: string[] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text === "acked chat=fast message=fast") release.resolve();
    if (logs.includes("acked chat=slow message=second") && logs.includes("acked chat=fast message=fast")) controller.abort();
  }, async (chat, message) => {
    if (message.uid === "slow") {
      started.resolve();
      await release.promise;
    } else if (message.uid === "fast") {
      await started.promise;
      assert.equal(await readFile(`${root}/plow-checkpoints/slow`, "utf8"), "old");
    } else {
      assert.equal(await readFile(`${root}/plow-checkpoints/slow`, "utf8"), "slow");
    }
    replies.push(message.uid);
    return "completed";
  });
  assert.deepEqual(replies, ["fast", "slow", "second"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/fast`, "utf8"), "fast");
  assert.equal(await readFile(`${root}/plow-checkpoints/slow`, "utf8"), "second");
});

for (const listed of [true, false]) test(`restart mid-turn replays unfinished chats once; listed=${listed}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const chats = ["slow", "fast"].map(acceptedChat);
  let boot = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: listed || boot > 0 ? chats : [], has_more: !listed } :
    url.includes("limit=50") ? { data: url.includes("/slow/") ? [inbound("later"), inbound("slow")] : [inbound("fast")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    if (boot === 2) return;
    for (const uid of ["slow", "fast"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: uid, data: { message: inbound(uid) } }));
  });
  const completed: string[] = [];
  const interrupted: string[] = [];
  for (; boot < 3; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (boot === 0 && text === "acked chat=fast message=fast") controller.abort();
    }, async (_chat, message) => {
      if (boot === 0 && message.uid === "slow") {
        await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        interrupted.push(message.uid);
        return "incomplete";
      }
      completed.push(message.uid);
      return "completed";
    });
    if (boot === 0) {
      assert.deepEqual(completed, ["fast"]);
      assert.notEqual(await readFile(`${root}/plow-checkpoints/slow`, "utf8"), "slow");
    }
  }
  assert.deepEqual(interrupted, ["slow"]);
  assert.deepEqual(completed, ["fast", "slow", "later"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/slow`, "utf8"), "later");
  assert.equal(await readFile(`${root}/plow-checkpoints/fast`, "utf8"), "fast");
});

test("only four chats run at once and a queued fifth runs when a slot opens", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chats = Array.from({ length: 5 }, (_, i) => acceptedChat(`chat-${i}`));
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const chat of chats) socket.send(JSON.stringify({ event_type: "message_received", event_id: chat.uid, chat_id: chat.uid,
      data: { message: inbound(chat.uid) } }));
  });
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  const releases = chats.map(() => Promise.withResolvers<void>());
  controller.signal.addEventListener("abort", () => releases.forEach(release => release.resolve()));
  const running = listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (chat) => {
    started.push(chat.uid);
    maximum = Math.max(maximum, ++active);
    await releases[chats.findIndex(item => item.uid === chat.uid)].promise;
    active--;
    return "completed";
  });
  while (started.length < 4 && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(started.length, 4);
  releases[0].resolve();
  while (started.length < 5 && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await running;
  assert.equal(maximum, 4);
  assert.equal(started.length, 5);
});

test("checkpoint failure prevents later queued messages from advancing that chat", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, "old");
  const chat = acceptedChat("chat");
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const writer = t.mock.method(fs, "writeFile", async () => { throw new Error("disk failure"); });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const uid of ["first", "later"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat.uid,
      data: { message: inbound(uid) } }));
  });
  const calls: string[] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("transport stopped")) controller.abort();
  }, async (_chat, message) => { calls.push(message.uid); return "completed"; });
  assert.deepEqual(calls, ["first"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), "old");
  assert.ok(logs.some(text => text.startsWith("transport stopped")));
});

for (const discovered of [false, true]) test(`a dropped socket discards queued turns but preserves discovery for reconnect recovery; discovered=${discovered}`, { timeout: 40_000 }, async t => {
  const { root, server, apiBase } = await websocketFixture(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  const release = Promise.withResolvers<void>();
  t.after(() => { clearTimeout(timeout); controller.abort(); release.resolve(); });
  const chats = ["busy-0", "busy-1", "busy-2", "busy-3", "new"].map(acceptedChat);
  await mkdir(`${root}/plow-checkpoints`);
  for (const chat of chats.slice(0, 4)) await writeFile(`${root}/plow-checkpoints/${chat.uid}`, "old");
  let connections = 0;
  let boundaryOnReconnect: string | undefined;
  const history = (chat: string) => chat === "new" ? ["new-second", "new-first"] :
    chat === "busy-0" ? [...(connections > 1 || discovered ? ["live-later"] : []), "recovery-later", chat, "old"] : [chat, "old"];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) {
      if (connections > 1) boundaryOnReconnect = await readFile(`${root}/plow-checkpoints/new`, "utf8").catch(() => "missing");
      return Response.json({ data: connections === 1 ? chats.slice(discovered ? 1 : 0, 4) : chats, has_more: false });
    }
    const chat = chats.find(chat => url.includes(`/chats/${chat.uid}`));
    return Response.json(url.includes("/messages?") ? {
      data: url.includes("limit=20") ? [] : history(chat!.uid).slice(0, url.includes("limit=1") ? 1 : undefined).map(inbound), has_more: false,
    } : chat ?? { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    connections++;
    if (discovered && connections === 1) socket.send(JSON.stringify({ event_type: "message_received", event_id: "live-later", chat_id: "busy-0", data: { message: inbound("live-later") } }));
  });
  const calls: { uid: string; connection: number }[] = [];
  const allStarted = Promise.withResolvers<void>();
  const recovered: string[] = [];
  const running = listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    if (connections > 1 && text.startsWith("acked")) {
      recovered.push(text);
      if (recovered.length === 4) controller.abort();
    }
  }, async (_chat, message) => {
    calls.push({ uid: message.uid, connection: connections });
    if (connections === 1) {
      if (!message.uid.startsWith("busy-")) controller.abort();
      if (calls.length === 4) allStarted.resolve();
      await release.promise;
    }
    return "completed";
  });
  await allStarted.promise;
  for (const socket of server.clients) {
    for (const [chat, uid] of [["busy-0", "live-later"], ["new", "new-first"], ["new", "new-second"]]) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat, data: { message: inbound(uid) } }));
    }
    await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
    await new Promise<void>(resolve => { socket.once("close", resolve); socket.close(); });
  }
  // Let the client observe close before the active turns finish.
  await new Promise(resolve => setTimeout(resolve, 50));
  release.resolve();
  await running;
  assert.deepEqual(calls.filter(call => call.connection === 1).map(call => call.uid).sort(), chats.slice(0, 4).map(chat => chat.uid));
  assert.equal(connections, 2);
  assert.equal(boundaryOnReconnect, "first:new-first");
  assert.deepEqual(calls.filter(call => call.connection === 2).map(call => call.uid).sort(), ["live-later", "new-first", "new-second", "recovery-later"]);
  assert.equal(await readFile(`${root}/plow-checkpoints/busy-0`, "utf8"), "live-later");
  assert.equal(await readFile(`${root}/plow-checkpoints/new`, "utf8"), "new-second");
});

for (const listed of [false, true]) test(`traversal chat IDs keep checkpoint reads and writes inside their directory; listed=${listed}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const chat = acceptedChat("../outside");
  await writeFile(`${root}/outside`, "first:later");
  await writeFile(`${root}/outside.tmp`, "untouched");
  let boot = 0;
  server.on("connection", socket => {
    socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${boot}`,
      chat_id: chat.uid, data: { message: inbound("first") } }));
  });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: listed ? [chat] : [], has_more: false } :
    url.endsWith(`/chats/${chat.uid}`) ? chat :
    url.endsWith("limit=50") ? { data: [inbound("later"), inbound("first")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const turns: string[] = [];
  for (; boot < 2; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (text === `acked chat=${chat.uid} message=later`) controller.abort();
    }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
    assert.deepEqual(turns, ["first", "later"]);
    assert.equal(await readFile(`${root}/outside`, "utf8"), "first:later");
    assert.equal(await readFile(`${root}/outside.tmp`, "utf8"), "untouched");
    assert.equal(await readFile(`${root}/plow-checkpoints/${encodeURIComponent(chat.uid)}`, "utf8"), "later");
  }
});

test("email chats run concurrently and drain received work after socket close", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chats = ["slow-email", "fast-email"].map(acceptedChat);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => { started.resolve(); release.resolve(); });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", socket => {
    for (const [chat, uid] of [["slow-email", "first"], ["slow-email", "later"], ["fast-email", "fast"]]) socket.send(JSON.stringify({
      event_type: "message_received", event_id: uid, chat_id: chat, data: { message: inbound(uid) },
    }));
  });
  const turns: string[] = [];
  const completed: string[] = [];
  const running = listen({ ...account, apiBase, accountId: "email", emailLineUid: "line" }, controller.signal, text => {
    if (text === "acked chat=slow-email message=later") controller.abort();
  }, async (_chat, message) => {
    turns.push(message.uid);
    if (message.uid === "first") await release.promise;
    if (message.uid === "fast") started.resolve();
    completed.push(message.uid);
    return "completed";
  });
  await started.promise;
  for (const socket of server.clients) {
    if (controller.signal.aborted) break;
    const pong = once(socket, "pong");
    socket.ping();
    await pong;
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  release.resolve();
  await running;
  assert.deepEqual(turns, ["first", "fast", "later"]);
  assert.deepEqual(completed, ["fast", "first", "later"]);
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  assert.deepEqual(await fs.readdir(`${root}/plow-checkpoints`), []);
});

for (const listed of [false, true]) test(`empty and dot-segment chat IDs are rejected before checkpoint discovery; listed=${listed}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const invalid = ["", ".", ".."];
  const chat = acceptedChat("valid");
  server.on("connection", socket => {
    for (const uid of [...invalid, chat.uid]) socket.send(JSON.stringify({
      event_type: "message_received", event_id: `event-${uid}`, chat_id: uid, data: { message: inbound(`message-${uid}`) },
    }));
  });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: listed ? [...invalid.map(acceptedChat), chat] : [], has_more: false } :
    url.endsWith("/chats/valid") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const logs: string[] = [];
  const turns: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("transport stopped") || text === "acked chat=valid message=message-valid") controller.abort();
  }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  assert.deepEqual(turns, ["message-valid"]);
  assert.ok(!logs.some(text => text.startsWith("transport stopped")));
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
});
