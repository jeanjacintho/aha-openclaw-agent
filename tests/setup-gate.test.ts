import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { clearDraft, deferSetup, getDraft, nextQuestion, recordAnswers, setupStatus, SETUP_DEFER_MS } from "../aha/setup/draft.ts";
import { openStore } from "../aha/store/db.ts";
import entry from "../plugin/index.ts";
import { gateContext, isOwnerDm, isOwnerDmTurn, OWNER_DM_SESSION, runGate, skipReason } from "../plugin/setup-gate.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-gate-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir });
  return dir;
}

const NOW = new Date("2026-09-25T12:00:00.000Z");

test("questions come in order and each is skipped once its fields are recorded", () => {
  assert.equal(nextQuestion({}), "company");
  assert.equal(nextQuestion({ company: "Plow" }), "aliases");
  assert.equal(nextQuestion({ company: "Plow", aliases: ["plow.co"] }), "aliases");
  assert.equal(nextQuestion({ company: "Plow", aliases: [], negatives: [] }), "competitors");
  assert.equal(nextQuestion({ company: "Plow", aliases: [], negatives: [], competitors: [] }), "sources");
  assert.equal(nextQuestion({ company: "Plow", aliases: [], negatives: [], competitors: [], sources: ["hn"] }), "voice");
  assert.equal(nextQuestion({ company: "Plow", aliases: [], negatives: [], competitors: [], sources: ["hn"], tone: "direct", lang: "pt-BR" }), "digest");
  assert.equal(nextQuestion({ company: "Plow", aliases: [], negatives: [], competitors: [], sources: ["hn"], tone: "direct", lang: "pt-BR", digestHour: 9, tz: "UTC" }), "close");
  // Answers given out of order are kept; the first unanswered question still comes next.
  assert.equal(nextQuestion({ competitors: ["zonk"], digestHour: 9 }), "company");
});

test("a fresh install needs setup and names the first question", async t => {
  await home(t);
  const store = openStore();
  t.after(() => store.close());
  assert.equal(setupStatus(store, NOW), "SETUP_NEEDED\nDRAFT:none\nNEXT:company");
});

test("recorded answers show up in DRAFT and move NEXT along", async t => {
  await home(t);
  const store = openStore();
  t.after(() => store.close());
  recordAnswers(store, { company: "Plow", domain: "plow.co" });
  recordAnswers(store, { aliases: ["Plow agents"], negatives: ["snow plow"] });
  assert.equal(setupStatus(store, NOW), "SETUP_NEEDED\nDRAFT:company,domain,aliases,negatives\nNEXT:competitors");
  recordAnswers(store, { company: "Plow PBC" });
  assert.equal(getDraft(store).answers.company, "Plow PBC");
  assert.deepEqual(getDraft(store).answers.aliases, ["Plow agents"]);
});

test("a saved watch is READY whatever the draft holds", async t => {
  await home(t);
  const store = openStore();
  t.after(() => store.close());
  recordAnswers(store, { company: "Half done" });
  saveConfig(store, { company: { name: "Plow" } });
  assert.equal(setupStatus(store, NOW), "READY");
});

test("not now keeps the gate quiet for 24 hours, then setup is offered again", async t => {
  await home(t);
  const store = openStore();
  t.after(() => store.close());
  recordAnswers(store, { company: "Plow" });
  const until = deferSetup(store, NOW);
  assert.equal(Date.parse(until) - NOW.getTime(), SETUP_DEFER_MS);
  assert.equal(setupStatus(store, new Date(NOW.getTime() + SETUP_DEFER_MS - 1)), `DEFERRED\nUNTIL:${until}`);
  assert.equal(setupStatus(store, new Date(NOW.getTime() + SETUP_DEFER_MS)), "SETUP_NEEDED\nDRAFT:company\nNEXT:aliases");
});

test("answering during a deferral ends it", async t => {
  await home(t);
  const store = openStore();
  t.after(() => store.close());
  deferSetup(store, NOW);
  recordAnswers(store, { company: "Plow" });
  assert.equal(getDraft(store).deferredUntil, null);
  assert.equal(setupStatus(store, NOW), "SETUP_NEEDED\nDRAFT:company\nNEXT:aliases");
  clearDraft(store);
  assert.deepEqual(getDraft(store), { answers: {}, deferredUntil: null });
});

test("setup belongs to the owner's solo DM only", () => {
  const self = { type: "agent", relationship: "self", line: { uid: "line" } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const guest = { ...owner, uid: "guest", role: "member" };
  const chat = (...participants: object[]) => ({ uid: "c", status: "active", trusted: false, participants }) as never;
  assert.equal(isOwnerDm(chat(self, owner)), true);
  assert.equal(isOwnerDm(chat(self, owner, guest)), false);
  assert.equal(isOwnerDm(chat(self, guest)), false);
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "chat", sessionKey: OWNER_DM_SESSION, trigger: "user" }), true);
  assert.equal(isOwnerDmTurn({ channel: "plow", sessionKey: OWNER_DM_SESSION }), true);
  // A live owner turn: the channel field is not what the check can rely on.
  assert.equal(isOwnerDmTurn({ sessionKey: OWNER_DM_SESSION, trigger: "user" }), true);
  assert.equal(isOwnerDmTurn({ channel: "webchat", sessionKey: OWNER_DM_SESSION, trigger: "user" }), true);
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "chat", sessionKey: OWNER_DM_SESSION, trigger: "cron" }), false);
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "email", sessionKey: OWNER_DM_SESSION }), false);
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "chat", sessionKey: "agent:main:plow:group:cht_1" }), false);
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "chat", sessionKey: OWNER_DM_SESSION, trigger: "heartbeat" }), false);
  assert.equal(isOwnerDmTurn(undefined), false);
});

type Hook = (event: object, ctx: object) => Promise<{ prependContext?: string } | undefined>;
function hook(logs: string[] = []): Hook {
  let handler: Hook | undefined;
  entry.register({
    registrationMode: "full",
    runtime: {},
    logger: { info(text: string) { logs.push(String(text)); } },
    on(name: string, fn: Hook) { if (name === "before_prompt_build") handler = fn; },
    registerChannel() {},
    registerTool() {},
  } as never);
  assert.ok(handler, "before_prompt_build is registered");
  return handler;
}

const ownerTurn = { channel: "plow", accountId: "chat", sessionKey: OWNER_DM_SESSION, trigger: "user" };

test("the owner's DM turn starts from the gate", async t => {
  await home(t);
  const logs: string[] = [];
  const result = await hook(logs)({}, ownerTurn);
  assert.match(result?.prependContext ?? "", /SETUP_NEEDED\nDRAFT:none\nNEXT:company/);
  assert.ok(logs.includes("aha setup gate: SETUP_NEEDED DRAFT:none NEXT:company"));
});

test("a configured install gets READY in the owner's DM", async t => {
  await home(t);
  const store = openStore();
  saveConfig(store, { company: { name: "Plow" } });
  store.close();
  const result = await hook()({}, ownerTurn);
  assert.match(result?.prependContext ?? "", /```text\nREADY\n```/);
});

test("groups and other people's DMs get nothing from the gate", async t => {
  await home(t);
  assert.equal(await hook()({}, { channel: "plow", accountId: "chat", sessionKey: "agent:main:plow:group:cht_1", trigger: "user" }), undefined);
  assert.equal(await hook()({}, { channel: "plow", accountId: "chat", sessionKey: "agent:main:plow:direct:mem_guest", trigger: "user" }), undefined);
});

test("a gate that cannot open the store injects nothing", async t => {
  const dir = await home(t);
  const blocker = path.join(dir, "not-a-dir");
  await fs.writeFile(blocker, "");
  env(t, { AHA_HOME: path.join(blocker, "aha") });
  assert.equal(runGate(), undefined);
  const logs: string[] = [];
  assert.equal(await hook(logs)({}, ownerTurn), undefined);
  assert.ok(logs.includes("aha setup gate unavailable; prompt fallback applies"));
});

test("the injected context points at the setup rules", () => {
  const text = gateContext("SETUP_NEEDED\nDRAFT:none\nNEXT:company");
  assert.match(text, /SETUP_NEEDED\nDRAFT:none\nNEXT:company/);
  assert.match(text, /AGENTS\.md/);
});

test("the owner's turn gets the gate even when the hook context has no channel fields", async t => {
  await home(t);
  const result = await hook()({}, { sessionKey: OWNER_DM_SESSION, trigger: "user" });
  assert.match(result?.prependContext ?? "", /SETUP_NEEDED/);
});

test("a skipped user turn in the owner's session is logged, other skips are not", async t => {
  await home(t);
  const logs: string[] = [];
  const run = hook(logs);
  assert.equal(await run({}, { channel: "plow", accountId: "email", sessionKey: OWNER_DM_SESSION, trigger: "user", senderId: "plow-owner" }), undefined);
  const gateLogs = () => logs.filter(line => line.startsWith("aha setup gate"));
  assert.deepEqual(gateLogs(), ['aha setup gate skipped: {"channel":"plow","accountId":"email","trigger":"user","sessionKey":"agent:main:main","inDispatch":false}']);
  assert.ok(!gateLogs()[0].includes("plow-owner"));
  await run({}, { channel: "plow", accountId: "chat", sessionKey: OWNER_DM_SESSION, trigger: "heartbeat" });
  await run({}, { channel: "plow", accountId: "chat", sessionKey: "agent:main:plow:group:cht_1", trigger: "user" });
  assert.equal(gateLogs().length, 1);
  assert.equal(skipReason({ sessionKey: "agent:main:plow:group:cht_1", trigger: "user" }, false), undefined);
});
