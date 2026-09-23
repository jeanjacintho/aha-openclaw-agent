import { type DigestModel } from "./build.ts";

function when(iso: string | null) {
  if (!iso) return "";
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
}

function sourceLine(model: DigestModel, lang: string) {
  return model.sources.map(row => {
    const name = row.source === "hn" ? "HN" : row.source === "agent-index" ? "Agent Index" : row.source;
    const since = when(row.since);
    const pt = lang.startsWith("pt");
    const why = row.status === "limitada" ? (pt ? "limite da API" : "API limit") : (row.detail || row.status);
    if (!since) return pt ? `${name} sem dados (${why})` : `${name} has no data (${why})`;
    return pt ? `${name} sem dados desde ${since} (${why})` : `${name} has no data since ${since} (${why})`;
  });
}

export function renderDigest(m: DigestModel, lang: string): string {
  const pt = lang.startsWith("pt");
  const health = sourceLine(m, lang);
  if (m.items.length === 0) {
    const line = pt
      ? `Nada que mude decisão hoje. ${m.readCount} menções lidas.`
      : `Nothing that changes a decision today. ${m.readCount} mentions read.`;
    return [line, ...health].join("\n").trim();
  }
  const heading = pt ? `Resumo ${m.day} (${m.role}) · ${m.readCount} menções lidas` : `Digest ${m.day} (${m.role}) · ${m.readCount} mentions read`;
  const items = m.items.map(item => {
    const url = item.url ? ` ${item.url}` : "";
    return `• [${item.urgency}] ${item.topic || item.category}: ${item.excerpt}${url}`;
  });
  return [heading, ...items, ...health].join("\n");
}
