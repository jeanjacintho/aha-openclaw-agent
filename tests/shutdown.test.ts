import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import { test } from "node:test";

for (const stage of ["ticket", "upgrade"]) test(`shutdown during WebSocket ${stage} exits without an unhandled error`, { timeout: 10_000 }, async t => {
  const root = await mkdtemp(`${tmpdir()}/plow-shutdown-`);
  const peers = new Set<Socket>();
  const server = createServer((_request, response) => {
    if (stage === "ticket") {
      child.once("message", () => response.end(JSON.stringify({ ticket: "fixture" })));
      child.send("stop");
    } else response.end(JSON.stringify({ ticket: "fixture" }));
  });
  server.on("connection", socket => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
  server.on("upgrade", () => child.send("stop"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { listen } from ${JSON.stringify(new URL("../plugin/transport.ts", import.meta.url).href)};
    const controller = new AbortController();
    process.on("message", () => { controller.abort(); process.send("aborted"); });
    await listen({ apiBase: "http://127.0.0.1:${address.port}", accountId: "chat" }, controller.signal, console.log, async () => "completed");
    process.disconnect();
  `], {
    env: { OPENCLAW_STATE_DIR: root, PLOW_AGENT_TOKEN: "shutdown-fixture" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  t.after(async () => {
    clearTimeout(timeout); child.kill(); await closed;
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const [code] = await closed;
  assert.equal(code, 0, errors);
});
