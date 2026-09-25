import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksToRawItems, diffBlocks, extractBlocks, type Block } from "../aha/sites/extract.ts";

const BLOG_TEXT = [
  "Acme Blog",
  "Changelog",
  "v2.3.0",
  "We shipped a new onboarding flow that cuts setup time in half for new teams joining the platform.",
  "v2.2.0",
  "Added dark mode across the dashboard and fixed a memory leak in the background sync worker.",
  "© 2026 Acme",
].join("\n\n");

test("extractBlocks splits paragraphs on blank lines and drops short nav-sized ones", () => {
  const blocks = extractBlocks({ url: "https://blog.example.com/changelog", text: BLOG_TEXT });
  const contents = blocks.map(b => b.content);
  assert.ok(contents.includes("We shipped a new onboarding flow that cuts setup time in half for new teams joining the platform."));
  assert.ok(contents.includes("Added dark mode across the dashboard and fixed a memory leak in the background sync worker."));
  // "Acme Blog", "Changelog", "v2.3.0", "v2.2.0", "© 2026 Acme" are all under the minimum length.
  assert.ok(!contents.some(c => c.length < 40), JSON.stringify(contents));
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(b => b.url === "https://blog.example.com/changelog"));
  // Same content on a later visit hashes the same, so diffBlocks can recognize it.
  const again = extractBlocks({ url: "https://blog.example.com/changelog", text: BLOG_TEXT });
  assert.deepEqual(again.map(b => b.key), blocks.map(b => b.key));
});

test("extractBlocks keys an X-style profile by post permalink, not by paragraph", () => {
  // Real shape from a live read of an X profile (posts run together with no blank line).
  const text = "Anthropic\n1,702 posts\nAnthropic\n@AnthropicAI\nWe're an AI safety and research company.\nanthropic.com\nJoined January 2021\nAnthropic\n@AnthropicAI\nSep 23\nIn the Democratic Republic of the Congo, health organizations are using Claude to respond to an outbreak.\n156\n67\n893\n137K";
  const links = [
    { href: "https://x.com/AnthropicAI/status/1970678089489678976", text: "Sep 23" },
    { href: "https://x.com/AnthropicAI/status/1970678089489678976?s=20", text: "Sep 23 (repeat link on the page)" },
    { href: "https://x.com/AnthropicAI/status/1969999999999999999", text: "" },
    { href: "https://x.com/AnthropicAI", text: "Anthropic" },
    { href: "https://anthropic.com", text: "anthropic.com" },
  ];
  const blocks = extractBlocks({ url: "https://x.com/AnthropicAI", text, links });
  assert.deepEqual(blocks.map(b => b.key), [
    "https://x.com/AnthropicAI/status/1970678089489678976",
    "https://x.com/AnthropicAI/status/1969999999999999999",
  ]);
  assert.equal(blocks[0].content, "Sep 23");
  // No link text at all: falls back to the URL so the block is never empty.
  assert.equal(blocks[1].content, "https://x.com/AnthropicAI/status/1969999999999999999");
});

test("a page with no post links falls back to paragraphs even if some links are present", () => {
  const blocks = extractBlocks({
    url: "https://example.com/",
    text: "This domain is for use in documentation examples without needing permission to reference it in writing.\n\nLearn more",
    links: [{ href: "https://iana.org/domains/example", text: "Learn more" }],
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /documentation examples/);
});

test("diffBlocks: the first visit is a silent baseline, later visits report only new blocks", () => {
  const a: Block = { key: "a", content: "first paragraph long enough to pass the minimum length check", url: "https://example.com/" };
  const b: Block = { key: "b", content: "second paragraph long enough to pass the minimum length check", url: "https://example.com/" };
  const baseline = diffBlocks([a, b], []);
  assert.deepEqual(baseline, { newBlocks: [], nextCursor: ["a", "b"] });

  const c: Block = { key: "c", content: "a third paragraph that showed up after the baseline visit ran", url: "https://example.com/" };
  const later = diffBlocks([a, b, c], baseline.nextCursor);
  assert.deepEqual(later.newBlocks, [c]);
  assert.deepEqual(later.nextCursor, ["a", "b", "c"]);

  // A block that disappeared from the page stays in the cursor; it is not re-reported if it comes back.
  const goneAndBack = diffBlocks([a], later.nextCursor);
  assert.deepEqual(goneAndBack, { newBlocks: [], nextCursor: ["a", "b", "c"] });
});

test("blocksToRawItems builds a stable externalId and falls back to the site's hostname", () => {
  const blocks: Block[] = [{ key: "abc123", content: "Something new on the page", url: "https://blog.example.com/post-1" }];
  const now = new Date("2026-09-26T09:00:00.000Z");
  const labeled = blocksToRawItems({ url: "https://blog.example.com/changelog", label: "Competitor changelog" }, blocks, now);
  assert.deepEqual(labeled, [{
    source: "site", externalId: "https://blog.example.com/changelog#abc123", url: "https://blog.example.com/post-1",
    author: "Competitor changelog", body: "Something new on the page", publishedAt: now.toISOString(),
  }]);
  const unlabeled = blocksToRawItems({ url: "https://blog.example.com/changelog", label: null }, blocks, now);
  assert.equal(unlabeled[0].author, "blog.example.com");
});
