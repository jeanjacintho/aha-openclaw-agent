export function redditSubreddit(url: string | null | undefined) {
  const match = (url ?? "").match(/reddit\.com\/r\/([^/?#]+)/i);
  if (match) return match[1].toLowerCase();
}

export function redditThreadId(url: string | null | undefined) {
  const permalink = (url ?? "").match(/reddit\.com\/r\/[^/?#]+\/comments\/([^/?#]+)/i);
  if (permalink) {
    const id = permalink[1];
    return id.toLowerCase().startsWith("t3_") ? id.toLowerCase() : `t3_${id.toLowerCase()}`;
  }
  const name = (url ?? "").match(/\/(t3_[a-z0-9]+)\b/i);
  if (name) return name[1].toLowerCase();
}

export function threadLedgerKey(source: string, externalId: string, url: string | null | undefined) {
  if (source === "reddit") {
    const thread = redditThreadId(url);
    if (thread) return `thread:reddit:${thread}`;
  }
  return `thread:${source}:${externalId}`;
}

export function postLedgerKey(day: string, source: string, externalId: string, url: string | null | undefined) {
  const sub = source === "reddit" ? redditSubreddit(url) : undefined;
  if (sub) return `post:${day}:reddit:${sub}:${externalId}`;
  return `post:${day}:${source}:${externalId}`;
}
