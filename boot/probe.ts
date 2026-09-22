import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { probeIdentity } from "./probe-fixture.js";
import { renderConfig } from "./config.js";
import { startGateway } from "./process.js";

process.env.PLOW_AGENT_TOKEN = "probe-" + randomBytes(16).toString("hex");
process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
const config = renderConfig(probeIdentity, "http://127.0.0.1:1");
await mkdir("/var/lib/plow/workspace", { recursive: true });
const serialized = JSON.stringify(config, null, 2);
if ([process.env.PLOW_AGENT_TOKEN, process.env.OPENCLAW_GATEWAY_TOKEN].some(token => serialized.includes(token))) {
  throw new Error("Token leaked into rendered config");
}
await writeFile("/var/lib/plow/openclaw.json", serialized + "\n", { mode: 0o600 });
const child = await startGateway(true);
let succeeded = false;
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  console.error("plow-probe: gateway readiness timed out");
  process.kill(process.pid, "SIGTERM");
}, 60_000);
let log = "";
function observe(chunk: Buffer) {
  log += chunk.toString();
  if (!succeeded && !timedOut && log.includes("plow channel registered") && log.includes("[gateway] ready")) {
    succeeded = true;
    clearTimeout(timeout);
    console.log("PLOW_PROBE_OK");
    process.kill(process.pid, "SIGTERM");
  }
}
child.stdout!.on("data", chunk => { process.stdout.write(chunk); observe(chunk); });
child.stderr!.on("data", chunk => { process.stderr.write(chunk); observe(chunk); });
child.on("exit", code => {
  clearTimeout(timeout);
  if (!succeeded || code !== 0) process.exitCode = 1;
});
