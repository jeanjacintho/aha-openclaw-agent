import { trendSentence } from "../pipeline/trends.ts";
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

function countList(rows: { topic: string; n: number }[]) {
  return rows.map(row => `${row.topic} (${row.n})`).join(", ");
}

function competitorLines(m: DigestModel, lang: string) {
  const summary = m.competitors;
  if (!summary) return [];
  const has = summary.theyWin.length + summary.theyComplain.length + summary.weSolved.length;
  if (has === 0) return [];
  const pt = lang.startsWith("pt");
  const lines = [pt ? "Concorrência (7d)" : "Competition (7d)"];
  if (summary.theyWin.length) {
    lines.push(pt ? `eles ganham em: ${countList(summary.theyWin)}` : `they win at: ${countList(summary.theyWin)}`);
  }
  if (summary.theyComplain.length) {
    lines.push(pt ? `eles reclamam de: ${countList(summary.theyComplain)}` : `they complain about: ${countList(summary.theyComplain)}`);
  }
  if (summary.weSolved.length) {
    lines.push(pt ? `nós já resolvemos: ${countList(summary.weSolved)}` : `we already solved: ${countList(summary.weSolved)}`);
  }
  return lines;
}

export function renderDigest(m: DigestModel, lang: string): string {
  const pt = lang.startsWith("pt");
  const health = sourceLine(m, lang);
  const trends = m.trends.map(alert => trendSentence(alert, lang));
  const competitors = competitorLines(m, lang);
  if (m.items.length === 0 && trends.length === 0 && competitors.length === 0) {
    const line = pt
      ? `Nada que mude decisão hoje. ${m.readCount} menções lidas.`
      : `Nothing that changes a decision today. ${m.readCount} mentions read.`;
    return [line, ...health].join("\n").trim();
  }
  const heading = pt ? `Resumo ${m.day} (${m.role}) · ${m.readCount} menções lidas` : `Digest ${m.day} (${m.role}) · ${m.readCount} mentions read`;
  const items = m.items.map(item => {
    const url = item.url ? ` ${item.url}` : "";
    return `• [AHA-${item.id}] [${item.urgency}] ${item.topic || item.category}: ${item.excerpt}${url}`;
  });
  return [heading, ...items, ...trends, ...competitors, ...health].join("\n");
}
