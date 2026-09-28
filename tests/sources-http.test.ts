import assert from "node:assert/strict";
import { test } from "node:test";
import { AHA_HTTP_TIMEOUT_MS, withHttpTimeout } from "../aha/sources/http.ts";

test("source HTTP timeout helper bounds a request and defaults to 25 seconds", async () => {
  assert.equal(AHA_HTTP_TIMEOUT_MS, 25_000);
  const signal = withHttpTimeout({}, 1).signal!;
  assert.ok(signal instanceof AbortSignal);
  if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  assert.equal(signal.aborted, true);
});
