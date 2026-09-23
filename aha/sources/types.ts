import { type AhaConfig } from "../config.ts";

export type SourceId = "hn" | "ph" | "github" | "reddit" | "x" | "agent-index";

export type SourceQuery = {
  since: Date;
  until: Date;
  terms: string[];
};

export type RawItem = {
  source: string;
  externalId: string;
  url: string;
  author: string;
  title?: string;
  body: string;
  publishedAt: string;
  parentUrl?: string;
};

export type FetchResult =
  | { ok: true; items: RawItem[]; nextCursor: string | null }
  | { ok: false; error: "rate_limited" | "auth" | "network" | "unknown"; retryAfterMs?: number };

export interface SourceAdapter {
  id: SourceId;
  enabled(cfg: AhaConfig): boolean;
  fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult>;
}
