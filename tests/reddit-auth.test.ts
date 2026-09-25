import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRedditTokenCache, REDDIT_REFRESH_MARGIN_MS, REDDIT_TOKEN_URL, RedditAuthError, redditAuth } from "../aha/sources/reddit-auth.ts";
import { redditSource, withRedditToken } from "../aha/sources/reddit.ts";

type Call = { url: string; auth?: string | null; body?: string };

// A Reddit that issues numbered tokens valid for an hour.
function reddit(calls: Call[], opts: { status?: number } = {}): typeof fetch {
  let issued = 0;
  return async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : undefined });
    if (url === REDDIT_TOKEN_URL) {
      if (opts.status) return new Response(JSON.stringify({ error: "invalid_grant", echo: String(init?.body) }), { status: opts.status });
      issued += 1;
      return Response.json({ access_token: `tok${issued}`, token_type: "bearer", expires_in: 3600 });
    }
    return Response.json({ data: { children: [], after: null } });
  };
}

const creds = { clientId: "cid", clientSecret: "csecret" };

test("an app-only token is fetched once, reused, and renewed before it expires", async t => {
  clearRedditTokenCache();
  t.after(clearRedditTokenCache);
  const calls: Call[] = [];
  let now = 1_000_000;
  const auth = redditAuth(creds, { fetch: reddit(calls), now: () => now })!;
  assert.equal(auth.canPost, false);
  assert.equal(await auth.token(), "tok1");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
  assert.equal(calls[0].body, "grant_type=client_credentials");
  now += 3600_000 - REDDIT_REFRESH_MARGIN_MS - 1;
  assert.equal(await auth.token(), "tok1");
  assert.equal(calls.length, 1);
  now += 1;
  assert.equal(await auth.token(), "tok2");
  assert.equal(calls.length, 2);
});

test("account credentials use the password grant and may post", async t => {
  clearRedditTokenCache();
  t.after(clearRedditTokenCache);
  const calls: Call[] = [];
  const auth = redditAuth({ ...creds, username: "plowbot", password: "hunter2" }, { fetch: reddit(calls) })!;
  assert.equal(auth.canPost, true);
  await auth.token();
  assert.equal(calls[0].body, "grant_type=password&username=plowbot&password=hunter2");
});

test("a refused grant is an auth error that repeats nothing Reddit echoed", async t => {
  clearRedditTokenCache();
  t.after(clearRedditTokenCache);
  const auth = redditAuth({ ...creds, username: "plowbot", password: "hunter2" }, { fetch: reddit([], { status: 401 }) })!;
  await assert.rejects(auth.token(), (error: Error) => error instanceof RedditAuthError && error.message === "reddit token request failed: http 401" && !error.message.includes("hunter2"));
});

test("a token stored before credentials were supported is used as is", async () => {
  const auth = redditAuth("legacy")!;
  assert.equal(await auth.token(), "legacy");
  assert.equal(auth.canPost, true);
  assert.equal(redditAuth(undefined), undefined);
  assert.equal(redditAuth({ clientId: "", clientSecret: "x" }), undefined);
});

test("a 401 renews the token and tries once more", async t => {
  clearRedditTokenCache();
  t.after(clearRedditTokenCache);
  const calls: Call[] = [];
  const auth = redditAuth(creds, { fetch: reddit(calls) })!;
  const seen: string[] = [];
  const response = await withRedditToken(auth, async token => {
    seen.push(token);
    return new Response("", { status: seen.length === 1 ? 401 : 200 });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["tok1", "tok2"]);
});

test("the watch keeps working across an expiry and reports auth when Reddit refuses the app", async t => {
  clearRedditTokenCache();
  t.after(clearRedditTokenCache);
  const calls: Call[] = [];
  let now = 1_000_000;
  const http = reddit(calls);
  const source = redditSource({ fetch: http, auth: redditAuth(creds, { fetch: http, now: () => now }) });
  assert.equal(source.enabled({ company: { name: "Plow" } }), true);
  const query = { since: new Date(0), until: new Date(), terms: ["plow"] };
  assert.equal((await source.fetch(query, null)).ok, true);
  now += 3600_000;
  assert.equal((await source.fetch(query, null)).ok, true);
  const searches = calls.filter(call => call.url.startsWith("https://oauth.reddit.com/search"));
  assert.deepEqual(searches.map(call => call.auth), ["Bearer tok1", "Bearer tok2"]);

  clearRedditTokenCache();
  const refused = redditSource({ fetch: reddit([], { status: 401 }), auth: redditAuth(creds, { fetch: reddit([], { status: 401 }) }) });
  assert.deepEqual(await refused.fetch(query, null), { ok: false, error: "auth" });
  assert.equal(redditSource({}).enabled({ company: { name: "Plow" } }), false);
});
