import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";

const { WebSocketServer } = createRequire(new URL("../plugin/package.json", import.meta.url))("ws");

export async function websocketFixture(t: TestContext) {
  const root = await mkdtemp(`${tmpdir()}/plow-ws-`);
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const abortAfter = (ms = 2000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("WebSocket fixture deadline exceeded", "TimeoutError")), ms);
    t.after(() => { clearTimeout(timeout); controller.abort(); });
    return controller;
  };
  return { root, server, apiBase: `http://127.0.0.1:${server.address().port}`, abortAfter };
}
