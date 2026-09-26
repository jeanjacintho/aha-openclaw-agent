import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export async function startGateway(captureOutput = false, mcpUrl?: string, writeLog?: (chunk: Buffer) => void) {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    for (const child of children) child.kill("SIGTERM");
    timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 30_000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const launch = (label: string, args: string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, args, options);
    children.add(child);
    if (!captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => { process.stdout.write(chunk); writeLog?.(chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); writeLog?.(chunk); });
    }
    child.on("error", error => { console.error(error); if (label === "gateway") { process.exitCode = 1; stop(); } });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (label === "bridge" && !stopping) {
        console.error(`plow-boot: bridge exited code=${code} signal=${signal}; restarting in 1s`);
        restartTimer = setTimeout(startBridge, 1000);
        return;
      }
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
  const startBridge = () => launch("bridge", ["/opt/plow/boot/mcp-bridge.js"], {
    stdio: captureOutput ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "pipe", "pipe", "ipc"],
    env: { PLOW_MCP_URL: mcpUrl!, PLOW_AGENT_TOKEN: process.env.PLOW_AGENT_TOKEN, PLOW_MCP_BRIDGE_TOKEN: process.env.PLOW_MCP_BRIDGE_TOKEN },
  });
  if (mcpUrl) {
    const bridge = startBridge();
    await new Promise(resolve => { bridge.once("message", resolve); bridge.once("close", resolve); });
    if (stopping) return bridge;
  }
  return launch("gateway", ["/app/openclaw.mjs", "gateway"], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
}
