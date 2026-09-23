import { type AhaConfig } from "../config.ts";
import { readSecrets, type Secrets } from "../secrets.ts";
import { agentIndexSource } from "./agent-index.ts";
import { hnSource } from "./hn.ts";
import { type SourceAdapter } from "./types.ts";

export function agentIndexSlug(cfg: AhaConfig | null) {
  return cfg?.agentIndexSlug || process.env.AGENT_ID || "";
}

export function watchAdapters(cfg: AhaConfig | null, secrets: Secrets = readSecrets()): SourceAdapter[] {
  return [
    hnSource(),
    agentIndexSource({ token: secrets.github ?? "", slug: agentIndexSlug(cfg) }),
  ];
}
