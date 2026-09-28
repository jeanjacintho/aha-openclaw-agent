import { writeFileSync } from "node:fs";
import { ahaHome } from "../home.ts";
import { WORKER_AGENT } from "../../boot/llm.ts";
import { recordUsage } from "../usage/ledger.ts";
import { wrapPublicPosts } from "./prompts.ts";
import { type Schema } from "./schemas.ts";

// Classify and drafts use the same single model as the conversational agent:
// Plow's Luna, called directly, or, when boot moved inference off Plow and set
// AHA_LLM_GATEWAY, the gateway's tool-less worker agent, which carries the
// chosen model and Plow's fallback.
const PLOW_MODELS = ["openai/gpt-6-luna"];
export const GATEWAY_TARGET = `openclaw/${WORKER_AGENT}`;
// Per model call, just under the gateway's own 60s cutoff.
const DEFAULT_TIMEOUT_MS = 55_000;

export type CompleteRequest<T> = {
  purpose: string;
  system: string;
  data: unknown;
  schema: Schema<T>;
};

export type CompleteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; kind: "transport" | "content" };

type CompleteFailureKind = "transport" | "content";

class CompleteFailure extends Error {
  readonly kind: CompleteFailureKind;

  constructor(message: string, kind: CompleteFailureKind) {
    super(message);
    this.kind = kind;
  }
}

export type CompleteDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type ChatResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; input?: number; output?: number };
};

function models() {
  return process.env.AHA_LLM_GATEWAY ? [GATEWAY_TARGET] : PLOW_MODELS;
}

function apiBase() {
  if (process.env.AHA_LLM_GATEWAY) return process.env.AHA_LLM_GATEWAY;
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  return `${base}/v1/chat/completions`;
}

function headers() {
  // The gateway takes its per-boot password from loopback callers like this one.
  const token = process.env.AHA_LLM_GATEWAY ? process.env.OPENCLAW_GATEWAY_PASSWORD : process.env.PLOW_AGENT_TOKEN;
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
  } catch (error) {
    if (signal.aborted || isTimeout(error)) throw new CompleteFailure("timeout", "transport");
    throw new CompleteFailure(error instanceof Error ? error.message : "network error", "transport");
  }
  if (!response.ok) {
    const kind = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
      ? "transport"
      : "content";
    throw new CompleteFailure(`http ${response.status}`, kind);
  }
  try {
    return await response.json() as ChatResponse;
  } catch (error) {
    if (signal.aborted || isTimeout(error)) throw new CompleteFailure("timeout", "transport");
    const kind = error instanceof SyntaxError ? "content" : "transport";
    throw new CompleteFailure(error instanceof Error ? error.message : "invalid response json", kind);
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
  const candidates = models();
  let model = candidates[0];
  try {
    for (const [i, candidate] of candidates.entries()) {
      model = candidate;
      try {
        payload = await callModel(candidate, req, deps);
        break;
      } catch (error) {
        // Try the next configured model after a call failure or timeout, if there is one.
        if (i === candidates.length - 1) throw error;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    const kind = error instanceof CompleteFailure ? error.kind : "transport";
    return { ok: false, reason, kind };
  }
  if (!payload) return { ok: false, reason: "unknown", kind: "transport" };
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
    return { ok: false, reason: error instanceof Error ? error.message : "invalid json", kind: "content" };
  }
}
