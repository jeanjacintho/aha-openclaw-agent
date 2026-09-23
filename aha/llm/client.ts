import { recordUsage } from "../usage/ledger.ts";
import { wrapPublicPosts } from "./prompts.ts";
import { type Schema } from "./schemas.ts";

const GLM = "z-ai/glm-5.2";
const SONNET = "anthropic/claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 30_000;

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
        response_format: { type: "json_object" },
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

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid json");
  }
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
  let payload: ChatResponse;
  let model = GLM;
  try {
    try {
      payload = await callModel(GLM, req, deps);
    } catch (error) {
      if ((error as Error).message === "timeout" || (error as Error).name === "TimeoutError") throw error;
      model = SONNET;
      payload = await callModel(SONNET, req, deps);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return { ok: false, reason };
  }
  try {
    record(model, req.purpose, payload);
    return { ok: true, value: req.schema.parse(parseJson(contentOf(payload))) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid json" };
  }
}
