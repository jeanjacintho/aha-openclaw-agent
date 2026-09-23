/** State directory for the worker. Tests override it; production uses the volume. */
export function ahaHome() {
  return process.env.AHA_HOME || "/var/lib/plow/aha";
}
