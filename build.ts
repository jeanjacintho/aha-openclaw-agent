import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

for (const name of ["boot/agent-index", "boot/config", "boot/identity", "boot/prompt", "boot/main", "boot/process", "boot/probe", "boot/probe-fixture", "boot/mcp-bridge", "plugin/index", "plugin/transport", "plugin/aha-tools", "plugin/setup-gate", "aha/worker", "aha/home", "aha/usage/ledger", "aha/usage/budget", "aha/usage/openclaw-export", "aha/usage/ledger-export", "aha/store/db", "aha/store/retention", "aha/config", "aha/latch/bridge", "aha/setup/draft", "aha/sites/store", "aha/sites/extract", "aha/secrets", "aha/sources/types", "aha/sources/hn", "aha/sources/agent-index", "aha/sources/github", "aha/sources/producthunt", "aha/sources/reddit", "aha/sources/reddit-auth", "aha/sources/watch", "aha/sources/http", "aha/pipeline/ingest", "aha/pipeline/backfill", "aha/pipeline/classify", "aha/pipeline/topics", "aha/pipeline/trends", "aha/pipeline/route", "aha/pipeline/relevance", "aha/llm/client", "aha/llm/prompts", "aha/llm/schemas", "aha/notify/plow", "aha/scheduler", "aha/digest/build", "aha/digest/render", "aha/digest/deliver", "aha/responder/drafts", "aha/responder/policy", "aha/responder/autonomy", "aha/responder/post", "aha/responder/validate", "aha/responder/reddit-url", "aha/promises/check"]) {
  const raw = await readFile(`/opt/plow/${name}.ts`, "utf8");
  const source = name.startsWith("plugin/") ? raw.replaceAll(/from "\.\.\/aha\//g, 'from "../../aha/') : raw;
  const output = name.startsWith("plugin/") ? name.replace("plugin/", "plugin/dist/") : name;
  await mkdir(`/opt/plow/${output.substring(0, output.lastIndexOf("/"))}`, { recursive: true });
  await writeFile(`/opt/plow/${output}.js`, stripTypeScriptTypes(source.replaceAll(/(from "\.\.?\/[^"\n]+)\.ts"/g, '$1.js"')));
}
await writeFile("/opt/plow/probe", '#!/usr/bin/env node\nimport "./boot/probe.js";\n');
