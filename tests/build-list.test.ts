import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("build.ts compiles every module boot/main.ts imports", async () => {
  const build = await read("build.ts");
  const list: string[] = JSON.parse(build.match(/for \(const name of (\[[^\]]*\])/)![1]);
  const main = await read("boot/main.ts");
  const imports = [...main.matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)]
    .map(m => path.posix.normalize(path.posix.join("boot", m[1])));
  assert.ok(imports.includes("aha/worker"), "boot/main.ts no longer imports aha/worker");
  for (const name of imports) assert.ok(list.includes(name), `build.ts does not emit ${name}.js`);
});
