import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { identityFromApi } from "../boot/identity.ts";

function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
}

for (const status of [401, 403, 429, 503, "network"]) test(`identity retries temporary failure: ${status}`, async t => {
  mockClock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls > 1) return Response.json({ line: { uid: "line" }, chats: [] });
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(null, { status });
  });
  const result = identityFromApi("http://fixture", "test-token");
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  assert.equal((await result)?.line.uid, "line");
  assert.equal(calls, 2);
});

test("identity stops retrying unauthorized credentials at 120 seconds", async t => {
  mockClock(t);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  const result = assert.rejects(identityFromApi("http://fixture", "test-token"), /HTTP 401/);
  for (let i = 0; i <= 40; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(3_000);
  }
  await result;
});

for (const status of [429, 503, "network"]) test(`identity bounds transient retries: ${status}`, async t => {
  mockClock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(null, { status });
  });
  const result = assert.rejects(identityFromApi("http://fixture", "test-token"));
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(3_000);
  }
  await result;
  assert.equal(calls, 10);
});

test("identity does not swallow malformed JSON", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(identityFromApi("http://fixture", "test-token"), SyntaxError);
});

for (const body of ["null", "{}"])
  test(`identity refuses malformed shape: ${body}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(identityFromApi("http://fixture", "test-token"), TypeError);
  });

test("boot uses the identity endpoint that includes agent.name", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "http://fixture/v1/agents/me");
    return Response.json({ agent: { name: "Juniper" }, line: { uid: "line" }, chats: [] });
  });
  assert.equal((await identityFromApi("http://fixture", "test-token"))?.agent?.name, "Juniper");
});

test("identity rejects an empty line UID", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ line: { uid: "" }, chats: [] }));
  await assert.rejects(identityFromApi("http://fixture", "test-token"), /missing line uid/);
});
