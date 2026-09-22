import { spawn } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";

const CLIENT = "/opt/plow/agent-index-client.py";

/** Put OpenClaw's sessions where agentsview looks for them.
 *
 * HOME is the state volume, so `~` resolves there for the collector too. The
 * link names the sessions directory rather than the state root: a link to the
 * root would contain itself, and a collector walking it would not stop.
 */
export function linkSessions(state = "/var/lib/plow") {
  try {
    mkdirSync(`${state}/.openclaw`, { recursive: true });
    symlinkSync(`${state}/agents`, `${state}/.openclaw/agents`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      console.error(`agent-index: no session link, usage will read zero: ${(error as Error).message}`);
    }
  }
}

// Registers this agent on the Agent Index and reports its token usage every
// five minutes, the contract the Hermes base runs as an s6 service. This image
// has no supervision tree of its own, so the boot process owns the schedule.
//
// Usage comes from agentsview, which this image installs and which reads
// OpenClaw's own sessions -- at ~/.openclaw/agents, the path OpenClaw uses
// when OPENCLAW_STATE_DIR is unset. This image does set it, so the link below
// is what puts the sessions back where the collector looks.
//
// No switch. The reporter is here because this image carries it; an owner who
// does not want their usage on the Index builds without AGENT_ID, and then
// there is nothing to report for and this stands down.
export function startAgentIndex(interval = 300_000) {
  const agent = process.env.AGENT_ID;
  if (!agent) return undefined;
  // The Plow bearer is passed to the register pass only, the same split the
  // client documents: registration exchanges it once for an Index key, and
  // every report after that uses the key the client stored.
  //
  // HOME is the state volume, not the container's /home/node: the client keeps
  // this install's key and usage ledger under $HOME/.agent-index, and an
  // install that loses them on recreate re-registers as a new install and
  // strands the usage already published.
  const run = (args: string[], token?: string) => new Promise<number>(resolve => {
    const child = spawn("python3", [CLIENT, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { PATH: process.env.PATH!, HOME: "/var/lib/plow", AGENT_ID: agent, PLOW_API_BASE: process.env.PLOW_API_BASE!, ...(token ? { PLOW_AGENT_TOKEN: token } : {}) },
    });
    child.on("error", error => { console.error(`agent-index: ${error.message}`); resolve(1); });
    child.on("close", code => resolve(code ?? 1));
  });
  const pass = async () => {
    // 0 registered, 3 not registered, 2 state is there and unreadable. 2 is not
    // 3: registering over state the client cannot read mints against a new
    // install id and strands this install's published usage.
    const registered = await run(["status"]);
    if (registered !== 0 && registered !== 3) return console.error("agent-index: this install's state is unreadable (above), standing off rather than registering over it");
    if (registered === 3) {
      const register = ["--register", "--agent", agent];
      // Sent only when set. The Index leaves a field it is not given alone, so
      // an empty name would not clear the name, and one passed every pass would
      // overwrite an edit the owner made on their page.
      for (const [flag, value] of [["--name", process.env.AGENT_NAME], ["--blurb", process.env.AGENT_BLURB]] as const) if (value) register.push(flag, value);
      if (await run(register, process.env.PLOW_AGENT_TOKEN)) return console.error("agent-index: no index key this pass, not reporting");
    }
    if (await run(["--agent", agent])) console.error("agent-index: reporter exited non-zero, see the line above");
  };
  // Once, before the first pass: a report spawns the collector, and a link
  // made concurrently with it would land after the walk it is there for.
  linkSessions();
  void pass();
  // Never fatal, and never a reason to hold the process open: the gateway is
  // what this container is for.
  return setInterval(() => void pass(), interval).unref();
}
