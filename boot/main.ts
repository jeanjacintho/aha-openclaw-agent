import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { startAha } from "../aha/worker.js";
import { startAgentIndex } from "./agent-index.js";
import { renderConfig, syncConfig } from "./config.js";
import { identityFromApi } from "./identity.js";
import { llmRoute } from "./llm.js";
import { installBootLog } from "./log.js";
import { renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

try {
  const writeLog = installBootLog();
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_PASSWORD = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  const { route, problem } = llmRoute();
  if (problem) console.error(`plow-boot: llm: ${problem}`);
  console.log(`plow-boot: llm ${route.provider} ${route.primary}${route.fallbacks.length ? ` (fallback ${route.fallbacks.join(", ")})` : ""}`);
  const config = renderConfig(identity, base, route);
  // The worker calls Plow directly on Plow's route, and the gateway otherwise.
  if (route.provider === "plow") delete process.env.AHA_LLM_GATEWAY;
  else process.env.AHA_LLM_GATEWAY = "http://127.0.0.1:3000/v1/chat/completions";
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  await writeFile("/var/lib/plow/gateway-password", process.env.OPENCLAW_GATEWAY_PASSWORD + "\n", { mode: 0o600 });
  await chmod("/var/lib/plow/gateway-password", 0o600);
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN));
  await syncConfig(config, "/var/lib/plow/openclaw.json", "/etc/plow/openclaw");
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startAgentIndex(300_000, undefined, writeLog);
  await startGateway(false, identity.mcp_url ?? undefined, writeLog);
  startAha();
} catch (error) {
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
