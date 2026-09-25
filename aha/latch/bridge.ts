// The worker's own Latch client: MCP over the local bridge boot starts when
// the owner's Mac is connected (boot/mcp-bridge.ts, 127.0.0.1:18790). No model
// is involved; whatever a page says comes back as data only.

export const LATCH_BRIDGE_URL = "http://127.0.0.1:18790/mcp";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Why a Latch call did not complete, in words the status line can show. */
export type LatchFailure = "unavailable" | "denied" | "paused" | "failed";

// No parameter properties: build.ts only strips types.
export class LatchError extends Error {
  kind: LatchFailure;
  constructor(kind: LatchFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type LatchDeps = {
  url?: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type LatchClient = {
  /** Calls one Latch tool and returns its JSON result. */
  call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T>;
};

function classify(text: string): LatchFailure {
  if (/outside the approved origins|not approved|denied|declined|refused by the owner/i.test(text)) return "denied";
  if (/paused for/i.test(text)) return "paused";
  if (/unreachable|offline|not connected|no device|asleep/i.test(text)) return "unavailable";
  return "failed";
}

// The relay answers with JSON or a single SSE frame.
async function rpcBody(response: Response) {
  const raw = await response.text();
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
    : raw;
  return JSON.parse(body) as { result?: unknown; error?: { message?: string } };
}

export function latchClient(deps: LatchDeps = {}): LatchClient {
  const url = deps.url ?? LATCH_BRIDGE_URL;
  const token = deps.token ?? process.env.PLOW_MCP_BRIDGE_TOKEN ?? "";
  const http = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let session: string | undefined;
  let initialized = false;
  let nextId = 1;

  async function post(message: object): Promise<Response> {
    if (!token) throw new LatchError("unavailable", "Latch is not connected");
    try {
      return await http(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(message),
      });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError";
      throw new LatchError(timedOut ? "failed" : "unavailable", timedOut ? "Latch did not answer in time" : "Latch bridge unreachable");
    }
  }

  async function initialize() {
    if (initialized) return;
    const response = await post({
      jsonrpc: "2.0", id: nextId++, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aha-site-watch", version: "1" } },
    });
    if (!response.ok) throw new LatchError(response.status === 401 || response.status >= 500 ? "unavailable" : "failed", `Latch initialize http ${response.status}`);
    session = response.headers.get("mcp-session-id") ?? undefined;
    await response.text().catch(() => "");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then(r => r.text()).catch(() => "");
    initialized = true;
  }

  return {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      await initialize();
      const response = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
      if (!response.ok) throw new LatchError(response.status >= 500 ? "unavailable" : "failed", `Latch ${name} http ${response.status}`);
      let rpc: Awaited<ReturnType<typeof rpcBody>>;
      try {
        rpc = await rpcBody(response);
      } catch {
        throw new LatchError("failed", `Latch ${name} answered something that is not JSON-RPC`);
      }
      if (rpc.error) throw new LatchError(classify(rpc.error.message ?? ""), `Latch ${name}: ${(rpc.error.message ?? "error").slice(0, 200)}`);
      const result = rpc.result as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
      const text = (result?.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      if (result?.isError) throw new LatchError(classify(text), `Latch ${name}: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text) as T;
      } catch {
        return { text } as T;
      }
    },
  };
}

/**
 * One browser session scoped to `origins`, closed on every exit path. The
 * callback gets a `browser(action, args)` that is bound to the session.
 */
export async function withBrowser<R>(
  client: LatchClient,
  origins: string[],
  goal: string,
  use: (browser: (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<R>,
): Promise<R> {
  const opened = await client.call<{ session?: string }>("plow_browser_open", { origins, goal });
  if (!opened.session) throw new LatchError("failed", "Latch opened no browser session");
  const session = opened.session;
  try {
    return await use((action, args = {}) => client.call("plow_browser", { ...args, session, action }));
  } finally {
    await client.call("plow_browser_close", { session }).catch(() => undefined);
  }
}
