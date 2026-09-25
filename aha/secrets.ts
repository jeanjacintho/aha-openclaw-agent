import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { ahaHome } from "./home.ts";

// A Reddit "script" app. username and password (of the account that owns the
// app) are needed only to post replies; searching works without them.
export type RedditCredentials = {
  clientId: string;
  clientSecret: string;
  username?: string;
  password?: string;
};

export type Secrets = {
  productHunt?: string;
  github?: string;
  // A string is a bearer token stored before credentials were supported.
  reddit?: string | RedditCredentials;
};

function secretsPath(home: string) {
  return `${home}/secrets.json`;
}

export function readSecrets(home = ahaHome()): Secrets {
  try {
    return JSON.parse(readFileSync(secretsPath(home), "utf8")) as Secrets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function writeSecrets(home: string, secrets: Secrets) {
  mkdirSync(home, { recursive: true });
  const file = secretsPath(home);
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(secrets)}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
