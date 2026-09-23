import { runIngest, type IngestReport } from "./ingest.ts";
import { type Store } from "../store/db.ts";
import { type SourceAdapter } from "../sources/types.ts";

export const MAX_BACKFILL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runBackfill(
  store: Store,
  adapters: SourceAdapter[],
  days: number,
  now = new Date(),
  fetchImpl?: typeof fetch,
): Promise<IngestReport> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) {
    throw new Error("backfill days must be an integer from 1 to 30");
  }
  const until = now;
  const since = new Date(now.getTime() - days * DAY_MS);
  return runIngest(store, adapters, now, fetchImpl, { since, until });
}
