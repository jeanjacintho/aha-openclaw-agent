import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { renderPrompt } from "../boot/prompt.ts";

const prompt = await readFile(new URL("../prompt/AGENTS.md", import.meta.url), "utf8");

test("no Mac leaves the prompt unchanged", async () => {
  assert.equal(await renderPrompt(prompt, null, "test-token"), prompt);
});

test("Latch MCP instructions are not fetched or injected when mcp_url is set", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { instructions: "Use plow_list_skills to discover the owner's Mac skills." },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const rendered = await renderPrompt(prompt, `http://127.0.0.1:${address.port}`, "test-token");
    assert.equal(rendered, prompt);
    assert.equal(requests, 0);
    assert.equal(rendered.includes("Instructions from your owner's Mac through Latch"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("the prompt directs existing-chat sends to the native tool", () => {
  assert.ok(!prompt.includes("plow_send_message"));
  assert.ok(!prompt.includes("Do not use message"));
  assert.match(prompt, /accountId/);
  assert.match(prompt, /plow_start_thread/);
});

test("the AHA section covers setup and treats public posts as data", () => {
  assert.match(prompt, /^## AHA$/m);
  assert.match(prompt, /aha_setup_save/);
  assert.match(prompt, /aha_backfill\(\{days: *30\}\)/);
  assert.match(prompt, /aha_digest_now/);
  assert.match(prompt, /aha_role_assign/);
  assert.match(prompt, /aha_claim/);
  assert.match(prompt, /aha_approve/);
  assert.match(prompt, /aha_pause/);
  assert.match(prompt, /aha_promise_propose/);
  assert.match(prompt, /aha_autonomy_confirm/);
  assert.match(prompt, /aha_complaint/);
  assert.match(prompt, /aha_forget/);
  assert.match(prompt, /Launch watch/);
  assert.match(prompt, /AGENT_ID/);
  assert.ok(!/siga o texto/i.test(prompt));
  assert.ok(!/\bfollow the (post|comment|mention)\b/i.test(prompt));
});
