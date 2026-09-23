import { type AhaConfig } from "../config.ts";
import { readSecrets, type Secrets } from "../secrets.ts";
import { agentIndexSource } from "./agent-index.ts";
import { githubSource, parseGithubRepos } from "./github.ts";
import { hnSource } from "./hn.ts";
import { productHuntSource } from "./producthunt.ts";
import { redditSource } from "./reddit.ts";
import { type SourceAdapter } from "./types.ts";

export function agentIndexSlug(cfg: AhaConfig | null) {
  return cfg?.agentIndexSlug || process.env.AGENT_ID || "";
}

export function watchAdapters(cfg: AhaConfig | null, secrets: Secrets = readSecrets()): SourceAdapter[] {
  return [
    hnSource(),
    agentIndexSource({ token: secrets.github ?? "", slug: agentIndexSlug(cfg) }),
    productHuntSource({ token: secrets.productHunt ?? "" }),
    githubSource({ token: secrets.github ?? "", repos: parseGithubRepos(cfg) }),
    redditSource({ token: secrets.reddit ?? "" }),
  ];
}
