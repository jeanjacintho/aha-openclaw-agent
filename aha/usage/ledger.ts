import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { ahaHome } from "../home.ts";

export type UsageCall = {
  at: Date;
  model: string;
  input: number;
  output: number;
  purpose: string;
};

export type StoredUsage = {
  id: string;
  at: string;
  model: string;
  input: number;
  output: number;
  purpose: string;
};

function ledgerPath() {
  return `${ahaHome()}/usage.jsonl`;
}

function count(name: string, value: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`usage ${name} must be a finite number >= 0`);
  }
}

/** UTC day, so a reopen in another timezone still totals the same bucket. */
function dayOf(at: string) {
  return at.slice(0, 10);
}

export function listUsage(): StoredUsage[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: StoredUsage[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
      const row = value as Partial<StoredUsage>;
      if (typeof row.id !== "string" || !row.id || typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))
        || typeof row.model !== "string" || !row.model || typeof row.purpose !== "string" || !row.purpose
        || typeof row.input !== "number" || !Number.isFinite(row.input) || row.input < 0
        || typeof row.output !== "number" || !Number.isFinite(row.output) || row.output < 0) {
        throw new Error("invalid usage record");
      }
      rows.push(row as StoredUsage);
    } catch {
      // Don't log the row itself: usage records belong to the user's local data.
      console.error(`aha: skipping malformed usage ledger line ${index + 1}`);
    }
  }
  return rows;
}

export function recordUsage(u: UsageCall): void {
  if (!(u.at instanceof Date) || Number.isNaN(u.at.getTime())) throw new Error("usage at must be a valid date");
  if (typeof u.model !== "string" || u.model.length === 0) throw new Error("usage model is required");
  if (typeof u.purpose !== "string" || u.purpose.length === 0) throw new Error("usage purpose is required");
  count("input", u.input);
  count("output", u.output);
  const home = ahaHome();
  mkdirSync(home, { recursive: true });
  const line = JSON.stringify({ id: randomUUID(), at: u.at.toISOString(), model: u.model, input: u.input, output: u.output, purpose: u.purpose });
  appendFileSync(ledgerPath(), `${line}\n`, { mode: 0o600 });
}

export function dailyTotals(day: string): { model: string; input: number; output: number }[] {
  const totals = new Map<string, { model: string; input: number; output: number }>();
  for (const row of listUsage()) {
    if (dayOf(row.at) !== day) continue;
    const current = totals.get(row.model) ?? { model: row.model, input: 0, output: 0 };
    current.input += row.input;
    current.output += row.output;
    totals.set(row.model, current);
  }
  return [...totals.values()].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
}
