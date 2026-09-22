import { setTimeout as sleep } from "node:timers/promises";
import { type Identity } from "./config.ts";

export async function identityFromApi(base: string, token: string): Promise<Identity> {
  const authDeadline = Date.now() + 120_000;
  let failures = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${base}/v1/agents/me`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (++failures === 10) throw new Error("Identity request failed after 10 attempts");
      await sleep(3_000);
      continue;
    }
    if (response.ok) {
      const identity = await response.json() as Identity;
      if (!identity.line.uid) throw new Error("Identity is missing line uid");
      return identity;
    }
    if ([401, 403].includes(response.status) && Date.now() < authDeadline) {
      console.log(`plow-boot: identity HTTP ${response.status}; waiting for credential propagation`);
      await sleep(Math.min(3_000, authDeadline - Date.now()));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (++failures < 10) { await sleep(3_000); continue; }
    }
    throw new Error(`Identity request refused: HTTP ${response.status}`);
  }
}
