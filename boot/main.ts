import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { startAgentIndex } from "./agent-index.js";
import { renderConfig } from "./config.js";
import { identityFromApi } from "./identity.js";
import { renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

try {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  const config = renderConfig(identity, base);
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN));
  await writeFile("/var/lib/plow/openclaw.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startAgentIndex();
  await startGateway(false, identity.mcp_url ?? undefined);
} catch (error) {
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
