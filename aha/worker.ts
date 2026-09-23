import { mkdirSync } from "node:fs";

/** State directory for the worker. Tests override it; production uses the volume. */
export function ahaHome() {
  return process.env.AHA_HOME || "/var/lib/plow/aha";
}

// The gateway is what this container is for. A worker that fails to come up
// logs and stands down; it must not park boot the way an identity failure does.
export function startAha(): { stop(): Promise<void> } | undefined {
  try {
    mkdirSync(ahaHome(), { recursive: true });
    console.log("aha: worker up");
    return { async stop() {} };
  } catch (error) {
    console.error(`aha: worker standing down: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
