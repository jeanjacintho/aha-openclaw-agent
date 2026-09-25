import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { latchClient, LatchError, withBrowser } from "../aha/latch/bridge.ts";

type Rpc = { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type Handler = (rpc: Rpc, req: IncomingMessage) => { status?: number; sse?: boolean; result?: unknown; error?: { message: string }; delayMs?: number } | undefined;

async function bridge(t: import("node:test").TestContext, handle: Handler) {
  const seen: { rpc: Rpc; auth?: string; session?: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body) as Rpc;
    seen.push({ rpc, auth: req.headers.authorization, session: req.headers["mcp-session-id"] as string | undefined });
    if (rpc.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18" } }));
      return;
    }
    if (rpc.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    const out = handle(rpc, req) ?? {};
    if (out.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
    const payload = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...(out.error ? { error: out.error } : { result: out.result }) });
    res.writeHead(out.status ?? 200, { "content-type": out.sse ? "text/event-stream" : "application/json" });
    res.end(out.sse ? `event: message\ndata: ${payload}\n\n` : payload);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
}

const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

test("a tool call initializes once, keeps the MCP session and parses JSON or SSE results", async t => {
  const { url, seen } = await bridge(t, rpc => rpc.params?.name === "plow_browser" ? { sse: true, result: text({ text: "Example Domain" }) } : { result: text({ session: "b1" }) });
  const client = latchClient({ url, token: "bridge-token" });
  assert.deepEqual(await client.call("plow_browser_open", { origins: ["example.com"], goal: "g" }), { session: "b1" });
  assert.deepEqual(await client.call("plow_browser", { session: "b1", action: "text" }), { text: "Example Domain" });
  assert.deepEqual(seen.map(s => s.rpc.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  assert.ok(seen.every(s => s.auth === "Bearer bridge-token"));
  assert.deepEqual(seen.slice(1).map(s => s.session), ["sess-1", "sess-1", "sess-1"]);
});

test("Latch errors are classified for the status line", async t => {
  const answers: Record<string, ReturnType<Handler>> = {
    scope: { result: text("example.com is outside the approved origins [news.ycombinator.com] — use plow_browser_request to widen the session", true) },
    paused: { result: text("Paused for ~30s after three failures", true) },
    offline: { error: { message: "The Mac is offline" } },
    other: { result: text("something broke", true) },
    http: { status: 503 },
  };
  const { url } = await bridge(t, rpc => answers[String(rpc.params?.arguments?.case)]);
  const client = latchClient({ url, token: "x" });
  for (const [name, kind] of [["scope", "denied"], ["paused", "paused"], ["offline", "unavailable"], ["other", "failed"], ["http", "unavailable"]] as const) {
    await assert.rejects(client.call("plow_browser", { case: name }), (error: unknown) => error instanceof LatchError && error.kind === kind, name);
  }
});

test("no bridge token or no bridge means Latch is unavailable, and a slow answer times out", async t => {
  await assert.rejects(latchClient({ token: "" }).call("plow_browser_open", {}), (error: unknown) => error instanceof LatchError && error.kind === "unavailable");
  await assert.rejects(latchClient({ url: "http://127.0.0.1:9/mcp", token: "x", timeoutMs: 2000 }).call("plow_browser_open", {}), (error: unknown) => error instanceof LatchError && error.kind === "unavailable");
  const { url } = await bridge(t, () => ({ delayMs: 300, result: text({}) }));
  await assert.rejects(latchClient({ url, token: "x", timeoutMs: 100 }).call("plow_browser_open", {}), (error: unknown) => error instanceof LatchError && error.kind === "failed" && /in time/.test(error.message));
});

test("withBrowser scopes the session and closes it even when reading fails", async t => {
  const calls: string[] = [];
  const { url } = await bridge(t, rpc => {
    const name = rpc.params?.name ?? "";
    const args = rpc.params?.arguments ?? {};
    calls.push(`${name}${args.action ? ":" + args.action : ""}${args.session ? "@" + args.session : ""}`);
    if (name === "plow_browser_open") return { result: text({ session: "b7", origins: args.origins }) };
    if (args.action === "goto") return { result: text("boom", true) };
    return { result: text({ closed: true }) };
  });
  const client = latchClient({ url, token: "x" });
  await assert.rejects(withBrowser(client, ["example.com"], "site watch", browser => browser("goto", { url: "https://example.com/" })), LatchError);
  assert.deepEqual(calls, ["plow_browser_open", "plow_browser:goto@b7", "plow_browser_close@b7"]);
  const ok = await withBrowser(client, ["example.com"], "site watch", async () => "done");
  assert.equal(ok, "done");
  assert.equal(calls.at(-1), "plow_browser_close@b7");
});
