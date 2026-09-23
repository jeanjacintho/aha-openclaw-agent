export const PH_COMPLEXITY_BUDGET = 6250;
export const PH_CONSERVATIVE_COST = 250;
const PH_WINDOW_MS = 15 * 60 * 1000;

export function retryAfterMs(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
}

export function phQueryComplexity(headers: Headers) {
  const raw = headers.get("x-complexity") ?? headers.get("x-query-complexity");
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
}

export function phRemaining(headers: Headers) {
  const n = Number(headers.get("x-rate-limit-remaining"));
  if (Number.isFinite(n)) return n;
}

export function phResetMs(headers: Headers) {
  const retry = retryAfterMs(headers);
  if (retry !== undefined) return retry;
  const reset = Number(headers.get("x-rate-limit-reset"));
  if (!Number.isFinite(reset)) return PH_WINDOW_MS;
  if (reset > 1e9) return Math.max(0, reset * 1000 - Date.now());
  return reset * 1000;
}

export function phNextCost(opts: { headerCost?: number; previousRemaining?: number; remaining?: number }) {
  if (opts.headerCost !== undefined) return opts.headerCost;
  if (opts.previousRemaining !== undefined && opts.remaining !== undefined) {
    const delta = opts.previousRemaining - opts.remaining;
    if (delta > 0) return Math.min(delta, PH_COMPLEXITY_BUDGET);
  }
  return PH_CONSERVATIVE_COST;
}

export function phShouldBackoff(remaining: number | undefined, complexity: number | undefined) {
  if (remaining === undefined) return false;
  const need = Math.min(complexity ?? PH_CONSERVATIVE_COST, PH_COMPLEXITY_BUDGET);
  return remaining < need;
}
