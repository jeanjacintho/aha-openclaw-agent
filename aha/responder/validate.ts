const MAX_BODY = 500;
const PROMISE = /(?:\$|R\$|€|£)\s*\d|\d+\s*%|\b(?:off|desconto|discount|guaranteed|garantido)\b|\b(?:within|in|em)\s+\d+\s*(?:day|days|dias|week|weeks|semanas|hour|hours|horas)\b|\b(?:next week|semana que vem|tomorrow|amanh[aã]|by friday|at[eé] sexta)\b|\bper month\b|\bprazo\b|\brefund\b|\breembolso\b|\bwe will (?:ship|deliver)\b/i;
const PT_MARK = /[áàâãéêíóôõúç]|você|não|obrigad/i;
const EN_MARK = /\b(we are|thanks for|please |the |this )\b/i;
const BARE_HOST = /(?:^|[\s(\[])((?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)\]]*)?)/gi;
const COMMON_TLDS = new Set([
  "com", "org", "net", "edu", "gov", "io", "co", "app", "dev", "ai", "info", "biz", "us", "uk", "br", "de", "fr",
  "au", "ca", "in", "jp", "me", "gg", "tv", "cc", "xyz", "example", "test",
]);

export type ValidateResult = { ok: true; body: string } | { ok: false; reason: string };

function signature(company: string, lang: string) {
  if (lang.startsWith("pt")) return `— AHA, assistente de IA da ${company}`;
  return `— AHA, AI assistant of ${company}`;
}

function allowedUrls(itemUrl: string | null, links: string[] | undefined) {
  return [...(links ?? []), itemUrl].filter((url): url is string => typeof url === "string" && url.length > 0);
}

function parseHttpUrl(href: string): URL | undefined {
  try {
    if (!/^https?:\/\//i.test(href.trim())) return undefined;
    return new URL(href.trim());
  } catch {
    return undefined;
  }
}

function pathBoundary(got: string, allowed: string) {
  const a = allowed.endsWith("/") ? allowed.slice(0, -1) : allowed;
  const g = got.endsWith("/") && got.length > 1 ? got.slice(0, -1) : got;
  return g === a || g.startsWith(`${a}/`);
}

export function keepLink(href: string, allowed: string[]) {
  const got = parseHttpUrl(href);
  if (!got || got.username || got.password) return false;
  return allowed.some(entry => {
    const allow = parseHttpUrl(entry);
    if (!allow) return false;
    if (got.hostname.toLowerCase() !== allow.hostname.toLowerCase()) return false;
    return pathBoundary(got.pathname || "/", allow.pathname || "/");
  });
}

function markdownHrefs(text: string) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
}

function httpUrls(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s)]+/gi)].map(match => match[0]);
}

export function isBareHost(token: string) {
  const value = token.trim();
  if (!value || /^https?:\/\//i.test(value)) return false;
  if (/^www\./i.test(value)) return true;
  if (value.includes("/")) return true;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return COMMON_TLDS.has(labels[labels.length - 1].toLowerCase());
}

function bareHosts(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(BARE_HOST)) {
    const token = match[1];
    if (!token || !isBareHost(token)) continue;
    found.push(token);
  }
  return found;
}

export function stripOffListLinks(text: string, allowed: string[]) {
  let out = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full, label, href) => keepLink(String(href), allowed) ? full : String(label));
  out = out.replace(/https?:\/\/[^\s)]+/gi, url => keepLink(url, allowed) ? url : "");
  out = out.replace(BARE_HOST, (full, host) => isBareHost(String(host)) ? full.replace(host, "") : full);
  return out.replace(/[ \t]+\n/g, "\n").replace(/  +/g, " ").trim();
}

export function hasOffListLink(text: string, allowed: string[]) {
  if (httpUrls(text).some(url => !keepLink(url, allowed))) return true;
  if (markdownHrefs(text).some(href => !keepLink(href, allowed))) return true;
  return bareHosts(text).length > 0;
}

export function validateReply(text: string, ctx: { company: string; lang: string; url: string | null; links?: string[] }, mode: "clean" | "strict" = "clean"): ValidateResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty" };
  if (PROMISE.test(text)) return { ok: false, reason: "promise" };
  const allowed = allowedUrls(ctx.url, ctx.links);
  if (mode === "strict" && hasOffListLink(text, allowed)) return { ok: false, reason: "link" };
  let body = mode === "clean" ? stripOffListLinks(text, allowed) : text.trim();
  if (!body.trim()) return { ok: false, reason: "empty" };
  const lang = (ctx.lang || "en").toLowerCase();
  if (!lang.startsWith("pt") && !lang.startsWith("en")) return { ok: false, reason: "language" };
  if (lang.startsWith("pt") && (!PT_MARK.test(body) || EN_MARK.test(body))) return { ok: false, reason: "language" };
  if (lang.startsWith("en") && PT_MARK.test(body)) return { ok: false, reason: "language" };
  const sign = signature(ctx.company, lang);
  if (!body.includes(sign)) body = `${body}\n${sign}`.trim();
  if (body.length > MAX_BODY + sign.length + 2) return { ok: false, reason: "length" };
  return { ok: true, body };
}
