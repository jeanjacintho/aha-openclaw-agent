import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exportLedger } from "../aha/usage/ledger-export.ts";

const CLIENT = "/opt/plow/agent-index-client.py";

/** Keep one agentsview daemon alive instead of handing off every idle timeout.
 *
 * agentsview 0.44.0 lets a daemon go idle while it still holds db.write.lock:
 * for 15-40 minutes before it exits, each sync starts a replacement that dies
 * on that lock, and those passes report stale usage. A top-level
 * daemon_idle_timeout of "0s" keeps the daemon up. The file also holds the
 * daemon's own tokens, so the key is only prepended, never rewritten.
 */
export function keepAgentsviewDaemon(state = "/var/lib/plow") {
  const file = `${state}/.agentsview/config.toml`;
  try {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (/^\s*daemon_idle_timeout\s*=/m.test(current)) return;
    mkdirSync(`${state}/.agentsview`, { recursive: true, mode: 0o700 });
    writeFileSync(file, `daemon_idle_timeout = "0s"\n${current}`, { mode: 0o600 });
  } catch (error) {
    console.error(`agent-index: agentsview daemon stays on its idle timeout: ${(error as Error).message}`);
  }
}

// Registers this agent on the Agent Index and reports its token usage every
// five minutes, the contract the Hermes base runs as an s6 service. This image
// has no supervision tree of its own, so the boot process owns the schedule.
//
// OpenClaw's own transcripts come from the client, which reads its SQLite
// store directly; agentsview still covers the worker ledger exported below.
// OpenClaw 2026.9.4 stores transcripts in SQLite, so each pass exports that
// database (and the worker ledger) into those files and syncs before it reports.
// HOME stays /var/lib/plow: the install key lives under $HOME/.agent-index, and
// a different home would register a second install.
//
// No switch. The reporter is here because this image carries it; an owner who
// does not want their usage on the Index builds without AGENT_ID, and then
// there is nothing to report for and this stands down.
export function startAgentIndex(interval = 300_000, state = "/var/lib/plow") {
  const agent = process.env.AGENT_ID;
  if (!agent) return undefined;
  keepAgentsviewDaemon(state);
  // The Plow bearer is passed to the register pass only, the same split the
  // client documents: registration exchanges it once for an Index key, and
  // every report after that uses the key the client stored.
  //
  // HOME is the state volume, not the container's /home/node: the client keeps
  // this install's key and usage ledger under $HOME/.agent-index, and an
  // install that loses them on recreate re-registers as a new install and
  // strands the usage already published.
  const run = (command: string, args: string[], env: Record<string, string>) => new Promise<number>(resolve => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"], env });
    child.on("error", error => { console.error(`agent-index: ${error.message}`); resolve(1); });
    child.on("close", code => resolve(code ?? 1));
  });
  const python = (args: string[], token?: string) => run("python3", [CLIENT, ...args], {
    PATH: process.env.PATH!, HOME: "/var/lib/plow", AGENT_ID: agent, PLOW_API_BASE: process.env.PLOW_API_BASE!, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR!, ...(token ? { PLOW_AGENT_TOKEN: token } : {}),
  });
  const pass = async () => {
    const root = `${state}/.openclaw/agents`;
    try {
      exportLedger(root);
    } catch (error) {
      console.error(`agent-index: ${error instanceof Error ? error.message : String(error)}`);
    }
    // usage daily stays at 0 sessions until this sync. A failed sync still reports.
    if (await run("agentsview", ["sync"], { PATH: process.env.PATH!, HOME: "/var/lib/plow" })) console.error("agent-index: agentsview sync failed, reporting with what is already exported");
    // 0 registered, 3 not registered, 2 state is there and unreadable. 2 is not
    // 3: registering over state the client cannot read mints against a new
    // install id and strands this install's published usage.
    const registered = await python(["status"]);
    if (registered !== 0 && registered !== 3) return console.error("agent-index: this install's state is unreadable (above), standing off rather than registering over it");
    if (registered === 3) {
      const register = ["--register", "--agent", agent];
      // Sent only when set. The Index leaves a field it is not given alone, so
      // an empty name would not clear the name, and one passed every pass would
      // overwrite an edit the owner made on their page.
      for (const [flag, value] of [["--name", process.env.AGENT_NAME], ["--blurb", process.env.AGENT_BLURB]] as const) if (value) register.push(flag, value);
      if (await python(register, process.env.PLOW_AGENT_TOKEN)) return console.error("agent-index: no index key this pass, not reporting");
    }
    if (await python(["--agent", agent])) console.error("agent-index: reporter exited non-zero, see the line above");
  };
  void pass();
  // Never fatal, and never a reason to hold the process open: the gateway is
  // what this container is for.
  return setInterval(() => void pass(), interval).unref();
}
