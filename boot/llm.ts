import { readFileSync } from "node:fs";

// Where this install's inference goes. Plow is every install's provider: a
// one-click install has nothing to set and never leaves it. The owner of one
// install can move it to their own OpenAI account (`plow-llm openai` signs in
// and leaves the marker below) or name one with AGENT_PROVIDER and
// AGENT_MODEL. Plow's model stays behind as the fallback, so a
// spent quota or an expired sign-in degrades to Plow instead of to silence.
export const PLOW_MODEL = "plow/openai/gpt-6-luna";
export const LLM_MARKER = "/var/lib/plow/llm-provider";

export type LlmProvider = "plow" | "openai" | "openrouter";
export type LlmRoute = { provider: LlmProvider; primary: string; fallbacks: string[] };
export const PLOW_ROUTE: LlmRoute = { provider: "plow", primary: PLOW_MODEL, fallbacks: [] };

// Off Plow, the worker's classify and draft calls reach the chosen provider
// through the gateway, as this agent: no skills and one tool, session_status,
// so a post it is classifying has nothing it could act with. OpenClaw refuses
// a run whose tool list resolves to empty, so one read-only tool it keeps.
export const WORKER_AGENT = "aha-llm";

// OpenRouter has no model this image could guess, so it needs AGENT_MODEL.
const DEFAULT_MODEL: Partial<Record<LlmProvider, string>> = { openai: "gpt-6-luna" };

export function readLlmMarker(path = LLM_MARKER): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** AGENT_PROVIDER wins over the marker; anything unusable falls back to Plow and says why. */
export function llmRoute(env: NodeJS.ProcessEnv = process.env, marker = readLlmMarker()): { route: LlmRoute; problem?: string } {
  const chosen = (env.AGENT_PROVIDER?.trim() || marker || "plow").toLowerCase();
  if (chosen === "plow") return { route: PLOW_ROUTE };
  if (chosen !== "openai" && chosen !== "openrouter") {
    return { route: PLOW_ROUTE, problem: `unknown provider ${JSON.stringify(chosen)}, staying on Plow` };
  }
  const model = (env.AGENT_MODEL?.trim() || DEFAULT_MODEL[chosen])?.replace(new RegExp(`^${chosen}/`), "");
  if (!model) return { route: PLOW_ROUTE, problem: `${chosen} needs AGENT_MODEL, staying on Plow` };
  return { route: { provider: chosen, primary: `${chosen}/${model}`, fallbacks: [PLOW_MODEL] } };
}
