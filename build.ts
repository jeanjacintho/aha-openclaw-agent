import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

for (const name of ["boot/agent-index", "boot/config", "boot/identity", "boot/prompt", "boot/main", "boot/process", "boot/probe", "boot/probe-fixture", "boot/mcp-bridge", "plugin/index", "plugin/transport", "plugin/aha-tools", "aha/worker", "aha/home", "aha/usage/ledger", "aha/usage/openclaw-export", "aha/usage/ledger-export", "aha/store/db", "aha/config", "aha/secrets", "aha/sources/types", "aha/sources/hn", "aha/sources/agent-index", "aha/sources/watch", "aha/sources/http", "aha/pipeline/ingest", "aha/pipeline/backfill", "aha/pipeline/classify", "aha/pipeline/relevance", "aha/llm/client", "aha/llm/prompts", "aha/llm/schemas", "aha/notify/plow", "aha/scheduler", "aha/digest/build", "aha/digest/render", "aha/digest/deliver"]) {
  const raw = await readFile(`/opt/plow/${name}.ts`, "utf8");
  const source = name.startsWith("plugin/") ? raw.replaceAll(/from "\.\.\/aha\//g, 'from "../../aha/') : raw;
  const output = name.startsWith("plugin/") ? name.replace("plugin/", "plugin/dist/") : name;
  await mkdir(`/opt/plow/${output.substring(0, output.lastIndexOf("/"))}`, { recursive: true });
  await writeFile(`/opt/plow/${output}.js`, stripTypeScriptTypes(source.replaceAll(/(from "\.\.?\/[^"\n]+)\.ts"/g, '$1.js"')));
}
await writeFile("/opt/plow/probe", '#!/usr/bin/env node\nimport "./boot/probe.js";\n');
