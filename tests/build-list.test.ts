import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function localImports(file: string, text: string) {
  const dir = path.posix.dirname(file);
  return [...text.matchAll(/from "(\.{1,2}\/[^"]+)\.(?:js|ts)"/g)]
    .map(match => path.posix.normalize(path.posix.join(dir, match[1])));
}

test("build.ts compiles every module boot/main.ts imports", async () => {
  const build = await read("build.ts");
  const list: string[] = JSON.parse(build.match(/for \(const name of (\[[^\]]*\])/)![1]);
  const seen = new Set<string>();
  const pending = ["boot/main"];
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of localImports(`${name}.ts`, await read(`${name}.ts`))) pending.push(next);
  }
  assert.ok(seen.has("aha/worker"), "boot/main.ts no longer imports aha/worker");
  assert.ok(seen.has("aha/usage/openclaw-export"));
  assert.ok(seen.has("aha/usage/ledger-export"));
  for (const name of seen) assert.ok(list.includes(name), `build.ts does not emit ${name}.js`);
});
