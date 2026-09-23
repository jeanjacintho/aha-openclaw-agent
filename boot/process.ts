import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export async function startGateway(captureOutput = false, _mcpUrl?: string) {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 30_000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const launch = (label: string, args: string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, args, options);
    children.add(child);
    child.on("error", error => { console.error(error); if (label === "gateway") { process.exitCode = 1; stop(); } });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (!stopping && (code || signal)) {
        console.error(`plow-boot: ${label} exited code=${code} signal=${signal}`);
        process.exitCode = code || 1;
      }
      stop();
      if (!children.size) {
        clearTimeout(timer);
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    });
    return child;
  };
  return launch("gateway", ["/app/openclaw.mjs", "gateway"], {
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit", env: process.env,
  });
}
