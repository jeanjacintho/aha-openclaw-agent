import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SITES } from "../aha/sites/store.ts";
import { openStore } from "../aha/store/db.ts";
import entry from "../plugin/index.ts";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; details?: unknown };
type Tool = { name: string; execute: (id: string, args: Record<string, unknown>) => Promise<ToolResult> };
type ToolCtx = { senderIsOwner?: boolean; requesterSenderId?: string; nativeChannelId?: string };

const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const dm = { uid: "cht_dm", status: "active", trusted: true, participants: [self, owner] };
const group = { uid: "cht_group", status: "active", trusted: true, participants: [self, owner, { ...owner, uid: "guest", role: "member" }] };

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-sites-tools-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  process.env.AHA_HOME = dir;
  t.after(() => { delete process.env.AHA_HOME; });
  process.env.PLOW_API_BASE = "http://plow.test";
  process.env.PLOW_AGENT_TOKEN = "tok";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/v1/chats")) return Response.json({ data: [dm, group], has_more: false });
    return new Response("", { status: 404 });
  });
  return dir;
}

function tools(ctx: ToolCtx) {
  const byName = new Map<string, Tool>();
  const plow = { apiBase: process.env.PLOW_API_BASE, lineUid: "line", accountId: "chat" };
  entry.register({
    registrationMode: "full", runtime: {}, logger: { info() {} }, on() {},
    registerChannel() {}, registerCapabilities() {},
    registerTool(factory: (context: object) => Tool) {
      const tool = factory({ ...ctx, config: { channels: { plow } } });
      byName.set(tool.name, tool);
    },
  } as never);
  return byName;
}

const ownerDm = { senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" };
const guest = { senderIsOwner: false, requesterSenderId: "mem_guest", nativeChannelId: "cht_group" };

test("only the owner can add or remove a site; any member can list", async t => {
  await home(t);
  const denied = await tools(guest).get("aha_sites_add")!.execute("call", { url: "https://blog.example.com/" });
  assert.equal(denied.isError, true);
  const added = await tools(ownerDm).get("aha_sites_add")!.execute("call", { url: "https://blog.example.com/" });
  assert.equal(added.isError ?? false, false, JSON.stringify(added));
  const removeDenied = await tools(guest).get("aha_sites_remove")!.execute("call", { site: "https://blog.example.com/" });
  assert.equal(removeDenied.isError, true);
  const listed = await tools(guest).get("aha_sites_list")!.execute("call", {});
  assert.equal(listed.isError ?? false, false);
  assert.equal((listed.details as { sites: unknown[] }).sites.length, 1);
});

test("aha_sites_add validates the URL, defaults mode to mentions, and rejects a duplicate", async t => {
  const dir = await home(t);
  const map = tools(ownerDm);
  const bad = await map.get("aha_sites_add")!.execute("call", { url: "http://insecure.example.com/" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /https/);
  const localhost = await map.get("aha_sites_add")!.execute("call", { url: "https://localhost/admin" });
  assert.equal(localhost.isError, true);
  const missing = await map.get("aha_sites_add")!.execute("call", { url: "" });
  assert.equal(missing.isError, true);
  const first = await map.get("aha_sites_add")!.execute("call", { url: "https://blog.example.com/changelog/", label: "Zonk changelog" });
  assert.equal(first.isError ?? false, false);
  assert.deepEqual(first.details, { id: 1, url: "https://blog.example.com/changelog", label: "Zonk changelog", mode: "mentions" });
  const dup = await map.get("aha_sites_add")!.execute("call", { url: "https://BLOG.example.com/changelog" });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /already watching/);
  const all = await map.get("aha_sites_add")!.execute("call", { url: "https://x.com/AnthropicAI", mode: "all" });
  assert.equal((all.details as { mode: string }).mode, "all");
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sites").get<{ n: number }>()!.n, 2);
});

test("aha_sites_add enforces the site limit", async t => {
  await home(t);
  const map = tools(ownerDm);
  for (let i = 0; i < MAX_SITES; i++) {
    const result = await map.get("aha_sites_add")!.execute("call", { url: `https://example${i}.com/` });
    assert.equal(result.isError ?? false, false, `site ${i}`);
  }
  const over = await map.get("aha_sites_add")!.execute("call", { url: "https://one-too-many.example.com/" });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /at most 20/);
});

test("aha_sites_remove works by id or by URL and reports no match", async t => {
  await home(t);
  const map = tools(ownerDm);
  const added = await map.get("aha_sites_add")!.execute("call", { url: "https://blog.example.com/" });
  const id = (added.details as { id: number }).id;
  const notFound = await map.get("aha_sites_remove")!.execute("call", { site: "https://never-added.example.com/" });
  assert.equal(notFound.isError, true);
  const removedByUrl = await map.get("aha_sites_remove")!.execute("call", { site: "https://blog.example.com" });
  assert.equal(removedByUrl.isError ?? false, false);
  await map.get("aha_sites_add")!.execute("call", { url: "https://blog.example.com/" });
  const again = await map.get("aha_sites_list")!.execute("call", {});
  const newId = ((again.details as { sites: { id: number }[] }).sites[0]).id;
  // SQLite reuses a freed rowid, so newId may equal id; the point is remove-by-id works.
  const removedById = await map.get("aha_sites_remove")!.execute("call", { site: String(newId) });
  assert.equal(removedById.isError ?? false, false);
  assert.equal(typeof id, "number");
  const final = await map.get("aha_sites_list")!.execute("call", {});
  assert.equal((final.details as { sites: unknown[] }).sites.length, 0);
});

test("aha_sites_list shows the last run status", async t => {
  const dir = await home(t);
  const map = tools(ownerDm);
  await map.get("aha_sites_add")!.execute("call", { url: "https://blog.example.com/" });
  const store = openStore(dir);
  store.db.prepare("UPDATE sites SET last_run_at = ?, last_status = ?, last_detail = ? WHERE id = 1").run("2026-09-26T09:00:00.000Z", "degraded", "unavailable: Latch is not connected");
  store.close();
  const listed = await map.get("aha_sites_list")!.execute("call", {});
  assert.deepEqual((listed.details as { sites: unknown[] }).sites, [{
    id: 1, url: "https://blog.example.com", label: null, mode: "mentions", active: true,
    lastRunAt: "2026-09-26T09:00:00.000Z", lastStatus: "degraded", lastDetail: "unavailable: Latch is not connected",
  }]);
});
