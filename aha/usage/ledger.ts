import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { ahaHome } from "../worker.js";

export type UsageCall = {
  at: Date;
  model: string;
  input: number;
  output: number;
  purpose: string;
};

type StoredUsage = {
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

function readLedger(): StoredUsage[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as StoredUsage);
}

export function recordUsage(u: UsageCall): void {
  if (!(u.at instanceof Date) || Number.isNaN(u.at.getTime())) throw new Error("usage at must be a valid date");
  if (typeof u.model !== "string" || u.model.length === 0) throw new Error("usage model is required");
  if (typeof u.purpose !== "string" || u.purpose.length === 0) throw new Error("usage purpose is required");
  count("input", u.input);
  count("output", u.output);
  const home = ahaHome();
  mkdirSync(home, { recursive: true });
  const line = JSON.stringify({ at: u.at.toISOString(), model: u.model, input: u.input, output: u.output, purpose: u.purpose });
  appendFileSync(ledgerPath(), `${line}\n`, { mode: 0o600 });
}

export function dailyTotals(day: string): { model: string; input: number; output: number }[] {
  const totals = new Map<string, { model: string; input: number; output: number }>();
  for (const row of readLedger()) {
    if (dayOf(row.at) !== day) continue;
    const current = totals.get(row.model) ?? { model: row.model, input: 0, output: 0 };
    current.input += row.input;
    current.output += row.output;
    totals.set(row.model, current);
  }
  return [...totals.values()].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
}
