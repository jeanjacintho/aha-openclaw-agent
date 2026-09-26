import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("boot lines reach the console and a bounded state log", async t => {
  const state = await mkdtemp(join(tmpdir(), "plow-boot-log-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const moduleUrl = new URL("../boot/log.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(moduleUrl)}).then(({ installBootLog }) => {
    installBootLog();
    console.log("plow-boot: ready");
    console.error("plow-boot: parked");
    console.log("x".repeat(150000));
    console.log("y".repeat(150000));
  })`], { env: { ...process.env, OPENCLAW_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /plow-boot: ready/);
  assert.match(child.stderr, /plow-boot: parked/);
  const previous = await readFile(join(state, "boot.log.1"), "utf8");
  const current = await readFile(join(state, "boot.log"), "utf8");
  assert.match(previous, /plow-boot: ready/);
  assert.match(previous, /plow-boot: parked/);
  assert.ok(current.includes("y".repeat(150000)));
  assert.ok((await stat(join(state, "boot.log.1"))).size <= 256 * 1024);
  assert.ok((await stat(join(state, "boot.log"))).size <= 256 * 1024);
});

test("gateway and bridge output reaches the console and boot log", async t => {
  const state = await mkdtemp(join(tmpdir(), "plow-child-log-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const logUrl = new URL("../boot/log.ts", import.meta.url).href;
  const processUrl = new URL("../boot/process.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { syncBuiltinESMExports } from "node:module";
    import { PassThrough } from "node:stream";
    const children = [];
    childProcess.spawn = (_command, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { this.emit("close", null, "SIGTERM"); },
      });
      children.push(child);
      if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => child.emit("message", "ready"));
      return child;
    };
    syncBuiltinESMExports();
    const { installBootLog } = await import(${JSON.stringify(logUrl)});
    const { startGateway } = await import(${JSON.stringify(processUrl)});
    const writeLog = installBootLog();
    await startGateway(false, "https://relay/mcp", writeLog);
    children[0].stdout.write("bridge started\\n");
    children[0].stderr.write("bridge warning\\n");
    children[1].stdout.write("gateway started\\n");
    children[1].stderr.write("gateway failure\\n");
    children[1].emit("close", 0, null);
  `], { env: { ...process.env, OPENCLAW_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /bridge started/);
  assert.match(child.stdout, /gateway started/);
  assert.match(child.stderr, /bridge warning/);
  assert.match(child.stderr, /gateway failure/);
  const log = await readFile(join(state, "boot.log"), "utf8");
  for (const line of ["bridge started", "bridge warning", "gateway started", "gateway failure"]) assert.match(log, new RegExp(line));
});

test("Agent Index client and collector errors reach the console and boot log", async t => {
  const state = await mkdtemp(join(tmpdir(), "plow-index-log-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const logUrl = new URL("../boot/log.ts", import.meta.url).href;
  const indexUrl = new URL("../boot/agent-index.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { syncBuiltinESMExports } from "node:module";
    import { PassThrough } from "node:stream";
    childProcess.spawn = (command, args) => {
      const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stderr.write(command === "agentsview" ? "collector failure\\n" : "index client failure\\n");
        child.emit("close", command === "agentsview" || args.includes("status") ? 0 : 1, null);
      });
      return child;
    };
    syncBuiltinESMExports();
    const { installBootLog } = await import(${JSON.stringify(logUrl)});
    const { startAgentIndex } = await import(${JSON.stringify(indexUrl)});
    const timer = startAgentIndex(300_000, ${JSON.stringify(state)}, installBootLog());
    clearInterval(timer);
  `], { env: { ...process.env, AGENT_ID: "my-agent", OPENCLAW_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /collector failure/);
  assert.match(child.stderr, /index client failure/);
  assert.match(child.stderr, /see the line above/);
  const log = await readFile(join(state, "boot.log"), "utf8");
  for (const line of ["collector failure", "index client failure", "see the line above"]) assert.match(log, new RegExp(line));
  assert.ok(log.indexOf("index client failure") < log.indexOf("see the line above"));
});
