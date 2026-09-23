export function retryAfterMs(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
}
