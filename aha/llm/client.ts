import { writeFileSync } from "node:fs";
import { ahaHome } from "../home.ts";
import { recordUsage } from "../usage/ledger.ts";
import { wrapPublicPosts } from "./prompts.ts";
import { type Schema } from "./schemas.ts";

// Batch classify stays on GLM: on the Plow gateway, Kimi K2.5 reasons for
// 1500+ tokens even on one post and hits the gateway's 60s 504 on a batch of 20.
const MODELS = ["z-ai/glm-5.2", "anthropic/claude-sonnet-5"];
// Per model call, just under the gateway's own 60s cutoff.
const DEFAULT_TIMEOUT_MS = 55_000;

export type CompleteRequest<T> = {
  purpose: string;
  system: string;
  data: unknown;
  schema: Schema<T>;
};

export type CompleteResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export type CompleteDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type ChatResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; input?: number; output?: number };
};

function apiBase() {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  return `${base}/v1/chat/completions`;
}

function headers() {
  const token = process.env.PLOW_AGENT_TOKEN;
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function isTimeout(error: unknown) {
  const err = error as { name?: string; message?: string };
  return err.name === "TimeoutError" || err.name === "AbortError" || err.message === "timeout";
}

async function callModel(model: string, req: CompleteRequest<unknown>, deps: CompleteDeps): Promise<ChatResponse> {
  const http = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await http(apiBase(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: wrapPublicPosts(req.data) },
        ],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    return await response.json() as ChatResponse;
  } catch (error) {
    if (signal.aborted || isTimeout(error)) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    throw error;
  }
}

function contentOf(payload: ChatResponse) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("missing content");
  return content;
}

// How many leading `{` positions extractJson tries before giving up.
const MAX_OBJECT_STARTS = 5;

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The Plow gateway has corrupted the start of GLM's JSON-mode output (a stray
// `{` or `"{` before the real object), and without JSON mode models sometimes
// wrap the object in a ``` fence. The schema still validates whatever this returns.
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const candidate of fenced ? [text, fenced[1]] : [text]) {
    const parsed = tryParse(candidate.trim());
    if (parsed.ok) return parsed.value;
  }
  const end = text.lastIndexOf("}");
  let start = text.indexOf("{");
  for (let tried = 0; start !== -1 && start < end && tried < MAX_OBJECT_STARTS; tried += 1) {
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed.ok) return parsed.value;
    start = text.indexOf("{", start + 1);
  }
  throw new Error("invalid json");
}

// Keeps the last unparseable reply on the state volume so it can be inspected.
function keepInvalid(purpose: string, model: string, content: string) {
  try {
    writeFileSync(`${ahaHome()}/llm-invalid-last.txt`, `${new Date().toISOString()} ${purpose} ${model}\n${content}`);
  } catch {
    /* best effort */
  }
  console.error(`aha: ${purpose} ${model} returned invalid json (${content.length} chars): ${JSON.stringify(content.slice(0, 200))}`);
}

function tokens(payload: ChatResponse) {
  const usage = payload.usage ?? {};
  return {
    input: usage.prompt_tokens ?? usage.input ?? 0,
    output: usage.completion_tokens ?? usage.output ?? 0,
  };
}

function record(model: string, purpose: string, payload: ChatResponse) {
  const used = tokens(payload);
  recordUsage({ at: new Date(), model, input: used.input, output: used.output, purpose });
}

export async function complete<T>(req: CompleteRequest<T>, deps: CompleteDeps = {}): Promise<CompleteResult<T>> {
  let payload: ChatResponse | undefined;
  let model = MODELS[0];
  try {
    for (const [i, candidate] of MODELS.entries()) {
      model = candidate;
      try {
        payload = await callModel(candidate, req, deps);
        break;
      } catch (error) {
        // Timeouts fall through too: a stuck primary must not take the fallback down with it.
        if (i === MODELS.length - 1) throw error;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return { ok: false, reason };
  }
  if (!payload) return { ok: false, reason: "unknown" };
  try {
    record(model, req.purpose, payload);
    const content = contentOf(payload);
    let json: unknown;
    try {
      json = extractJson(content);
    } catch (error) {
      keepInvalid(req.purpose, model, content);
      throw error;
    }
    return { ok: true, value: req.schema.parse(json) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid json" };
  }
}
