import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ComposeConfig = {
  services: {
    agent: {
      ports: { host_ip: string; published: string; target: number }[];
      restart: string;
    };
  };
};

test("Compose keeps the agent on loopback, honors HOST_PORT, and restarts it", async t => {
  const compose = await fs.readFile(new URL("../compose.yml", import.meta.url), "utf8");
  assert.match(compose, /127\.0\.0\.1:\$\{HOST_PORT:-3001\}:3001/);
  assert.match(compose, /^\s+restart:\s*unless-stopped\s*$/m);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-compose-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(new URL("../compose.yml", import.meta.url), path.join(dir, "compose.yml"));
  await fs.writeFile(path.join(dir, "plow-credentials"), "PLOW_AGENT_TOKEN=test-token\n");
  await fs.mkdir(path.join(dir, "dev"));
  await fs.writeFile(path.join(dir, "dev/Caddyfile"), ":80 {\n  respond \"ok\"\n}\n");

  const render = (hostPort?: string) => {
    const env = { ...process.env };
    if (hostPort === undefined) delete env.HOST_PORT;
    else env.HOST_PORT = hostPort;
    return spawnSync("docker", ["compose", "-f", path.join(dir, "compose.yml"), "config", "--format", "json"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
  };

  const custom = render("3002");
  if (custom.error?.code === "ENOENT") {
    t.skip("Docker Compose CLI is unavailable; static Compose assertions passed");
    return;
  }
  assert.equal(custom.status, 0, custom.stderr);
  const customConfig = JSON.parse(custom.stdout) as ComposeConfig;
  assert.equal(customConfig.services.agent.restart, "unless-stopped");
  assert.deepEqual(customConfig.services.agent.ports, [{
    mode: "ingress",
    host_ip: "127.0.0.1",
    target: 3001,
    published: "3002",
    protocol: "tcp",
  }]);

  const defaults = render();
  assert.equal(defaults.status, 0, defaults.stderr);
  const defaultConfig = JSON.parse(defaults.stdout) as ComposeConfig;
  assert.equal(defaultConfig.services.agent.ports[0].published, "3001");
});
