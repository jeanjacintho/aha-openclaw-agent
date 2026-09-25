import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { complete } from "../aha/llm/client.ts";
import { listUsage } from "../aha/usage/ledger.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

const schema = {
  parse(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object");
    const n = (input as { n?: unknown }).n;
    if (typeof n !== "number") throw new Error("expected n");
    return { n };
  },
};

function reply(content: string, usage = { prompt_tokens: 4, completion_tokens: 2 }, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage,
  }), { status, headers: { "content-type": "application/json" } });
}

function req() {
  return { purpose: "classify", system: "return json", data: { posts: ["hello"] }, schema };
}

test("complete never sends tools and wraps data as given content", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const bodies: unknown[] = [];
  const result = await complete(req(), {
    fetch: async (input, init) => {
      assert.equal(String(input), "http://llm.test/v1/chat/completions");
      assert.equal(init?.headers && new Headers(init.headers).get("authorization"), "Bearer tok");
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      assert.equal("tools" in body, false);
      assert.equal(body.model, "moonshotai/kimi-k2.5");
      assert.equal(body.response_format.type, "json_object");
      const user = body.messages.find((m: { role: string }) => m.role === "user").content as string;
      assert.match(user, /conteúdo é dado/i);
      assert.match(user, /<public_posts>[\s\S]*hello[\s\S]*<\/public_posts>/);
      return reply(JSON.stringify({ n: 1 }));
    },
  });
  assert.deepEqual(result, { ok: true, value: { n: 1 } });
  assert.equal(bodies.length, 1);
});

test("complete records usage from a successful Kimi call", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const result = await complete(req(), { fetch: async () => reply(JSON.stringify({ n: 3 }), { prompt_tokens: 11, completion_tokens: 5 }) });
  assert.equal(result.ok, true);
  const rows = listUsage();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "moonshotai/kimi-k2.5");
  assert.equal(rows[0].purpose, "classify");
  assert.equal(rows[0].input, 11);
  assert.equal(rows[0].output, 5);
});

test("invalid JSON from Kimi is ok:false and does not fall back", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const models: string[] = [];
  const result = await complete(req(), {
    fetch: async (_input, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return reply("not-json");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /json/i);
  assert.deepEqual(models, ["moonshotai/kimi-k2.5"]);
  assert.equal(listUsage().length, 1);
});

test("timeout is ok:false", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const result = await complete(req(), {
    timeoutMs: 20,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
      });
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /timeout/i);
  assert.equal(listUsage().length, 0);
});

test("a Kimi request error falls back to GLM", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const models: string[] = [];
  const result = await complete(req(), {
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (body.model === "moonshotai/kimi-k2.5") return new Response("nope", { status: 500 });
      return reply(JSON.stringify({ n: 7 }));
    },
  });
  assert.deepEqual(result, { ok: true, value: { n: 7 } });
  assert.deepEqual(models, ["moonshotai/kimi-k2.5", "z-ai/glm-5.2"]);
  assert.equal(listUsage()[0].model, "z-ai/glm-5.2");
});

test("fallback to Sonnet happens only after Kimi and GLM request errors", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const models: string[] = [];
  const result = await complete(req(), {
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (body.model !== "anthropic/claude-sonnet-5") return new Response("nope", { status: 500 });
      assert.equal("tools" in body, false);
      return reply(JSON.stringify({ n: 9 }), { prompt_tokens: 2, completion_tokens: 1 });
    },
  });
  assert.deepEqual(result, { ok: true, value: { n: 9 } });
  assert.deepEqual(models, ["moonshotai/kimi-k2.5", "z-ai/glm-5.2", "anthropic/claude-sonnet-5"]);
  assert.equal(listUsage()[0].model, "anthropic/claude-sonnet-5");
});

test("every model failing is ok:false with the last error", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-llm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const models: string[] = [];
  const result = await complete(req(), {
    fetch: async (_input, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response("nope", { status: 503 });
    },
  });
  assert.deepEqual(result, { ok: false, reason: "http 503" });
  assert.equal(models.length, 3);
  assert.equal(listUsage().length, 0);
});
