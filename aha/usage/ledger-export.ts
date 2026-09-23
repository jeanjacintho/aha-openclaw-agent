import { mkdirSync } from "node:fs";
import { listUsage } from "./ledger.ts";
import { prepareOutputRoot, writeSession } from "./openclaw-export.ts";

// agentsview 0.44 syncs a session only when the file name is that session's id.
const SESSION = "a7a00000-0000-4000-8000-000000000001";
const FILE = `aha-worker/sessions/${SESSION}.jsonl`;

function message(row: { id: string; at: string; model: string; input: number; output: number; purpose: string }) {
  return JSON.stringify({
    type: "message",
    id: row.id,
    timestamp: row.at,
    message: {
      role: "assistant",
      content: [{ type: "text", text: row.purpose }],
      model: row.model,
      provider: "plow",
      usage: { input: row.input, output: row.output, cacheRead: 0, cacheWrite: 0, totalTokens: row.input + row.output },
      responseId: row.id,
    },
  });
}

/** Worker calls, as one OpenClaw session the same collector already reads. */
export function exportLedger(outRoot: string): { added: number } {
  prepareOutputRoot(outRoot);
  const records = listUsage().filter(row => row.id);
  mkdirSync(`${outRoot}/aha-worker/sessions`, { recursive: true });
  const dest = `${outRoot}/${FILE}`;
  return writeSession(dest, records.map(message), records[0] ? JSON.stringify({ type: "session", version: 4, id: SESSION, timestamp: records[0].at }) : undefined);
}
