import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

const maxBytes = 256 * 1024;

export function installBootLog() {
  const state = process.env.OPENCLAW_STATE_DIR;
  if (!state) throw new Error("OPENCLAW_STATE_DIR is required");
  const file = join(state, "boot.log");
  let size = existsSync(file) ? statSync(file).size : 0;
  const write = (chunk: Buffer) => {
    let line = chunk;
    if (line.length > maxBytes) line = line.subarray(line.length - maxBytes);
    if (size + line.length > maxBytes) {
      if (size) renameSync(file, `${file}.1`);
      size = 0;
    }
    appendFileSync(file, line, { mode: 0o600 });
    size += line.length;
  };
  for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => { original(...args); write(Buffer.from(format(...args) + "\n")); };
  }
  return write;
}
