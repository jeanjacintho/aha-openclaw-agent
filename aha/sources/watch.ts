import { type AhaConfig } from "../config.ts";
import { readSecrets, type Secrets } from "../secrets.ts";
import { agentIndexSource } from "./agent-index.ts";
import { githubSource, parseGithubRepos } from "./github.ts";
import { hnSource } from "./hn.ts";
import { productHuntSource } from "./producthunt.ts";
import { redditSource } from "./reddit.ts";
import { redditAuth } from "./reddit-auth.ts";
import { type SourceAdapter } from "./types.ts";

const SOURCE_IDS: Record<string, string> = {
  hn: "hn", hackernews: "hn",
  agentindex: "agent-index",
  ph: "ph", producthunt: "ph",
  github: "github",
  reddit: "reddit",
};

export function normalizeSourceId(raw: string) {
  return SOURCE_IDS[raw.toLowerCase().replace(/[\s_-]+/g, "")];
}

export function agentIndexSlug(cfg: AhaConfig | null) {
  return cfg?.agentIndexSlug || process.env.AGENT_ID || "";
}

export function watchAdapters(cfg: AhaConfig | null, secrets: Secrets = readSecrets()): SourceAdapter[] {
  const adapters = [
    hnSource(),
    agentIndexSource({ token: secrets.github ?? "", slug: agentIndexSlug(cfg) }),
    productHuntSource({ token: secrets.productHunt ?? "" }),
    githubSource({ token: secrets.github ?? "", repos: parseGithubRepos(cfg) }),
    redditSource({ auth: redditAuth(secrets.reddit) }),
  ];
  let selected: Set<string> | undefined;
  if (cfg?.sources?.length) {
    const normalized = cfg.sources.map(normalizeSourceId).filter((id): id is string => Boolean(id));
    if (normalized.length) selected = new Set(normalized);
    else console.error(`aha: configured sources were unrecognized (${cfg.sources.join(", ")}); enabling all credential-ready sources`);
  }
  return adapters.map(adapter => ({
    ...adapter,
    enabled(config) {
      return (!selected || selected.has(adapter.id)) && adapter.enabled(config);
    },
  }));
}
