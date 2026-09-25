import { createHash } from "node:crypto";
import { type RawItem } from "../sources/types.ts";

export type Block = { key: string; content: string; url: string };
export type Page = { url: string; text: string; links?: { href: string; text: string }[] };

const MIN_BLOCK_CHARS = 40;
// Individual posts, not the page they live on: /status/<id>. Matches x.com and
// the legacy twitter.com domain; a query or fragment after the id is dropped.
const STATUS_LINK = /\/status\/\d+/;

function hashBlock(content: string) {
  return createHash("sha256").update(content).digest("hex").slice(0, 20);
}

function canonicalStatusUrl(href: string) {
  try {
    const url = new URL(href);
    const match = url.pathname.match(/^(.*\/status\/\d+)/);
    return `${url.origin}${match ? match[1] : url.pathname}`;
  } catch {
    return href;
  }
}

function paragraphs(text: string) {
  return text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
}

/**
 * Splits a read page into blocks a later visit can tell apart from what it
 * already saw. A feed of post permalinks (X, and anything else that links to
 * individual posts) is keyed by the permalink, since the flat text runs posts
 * together with no blank line between them. Everything else is keyed by
 * paragraph content. Short paragraphs (nav labels, "Learn more") are dropped.
 */
export function extractBlocks(page: Page): Block[] {
  const statusLinks = (page.links ?? []).filter(link => STATUS_LINK.test(link.href));
  if (statusLinks.length > 0) {
    const seen = new Set<string>();
    const blocks: Block[] = [];
    for (const link of statusLinks) {
      const url = canonicalStatusUrl(link.href);
      if (seen.has(url)) continue;
      seen.add(url);
      blocks.push({ key: url, content: link.text.trim() || url, url });
    }
    return blocks;
  }
  return paragraphs(page.text)
    .filter(content => content.length >= MIN_BLOCK_CHARS)
    .map(content => ({ key: hashBlock(content), content, url: page.url }));
}

export type Diff = { newBlocks: Block[]; nextCursor: string[] };

/**
 * What is new since `seenKeys`. An empty cursor is the first visit: it
 * records the whole page as seen and reports nothing, so setup does not dump
 * a site's entire back-catalog into the digest.
 */
export function diffBlocks(blocks: Block[], seenKeys: string[]): Diff {
  const seen = new Set(seenKeys);
  const baseline = seenKeys.length === 0;
  const additions = blocks.filter(block => !seen.has(block.key)).map(block => block.key);
  return {
    newBlocks: baseline ? [] : blocks.filter(block => !seen.has(block.key)),
    nextCursor: [...seenKeys, ...additions],
  };
}

export function blocksToRawItems(site: { url: string; label: string | null }, blocks: Block[], now: Date): RawItem[] {
  const author = site.label?.trim() || new URL(site.url).hostname;
  return blocks.map(block => ({
    source: "site",
    externalId: `${site.url}#${block.key}`,
    url: block.url,
    author,
    body: block.content,
    publishedAt: now.toISOString(),
  }));
}
