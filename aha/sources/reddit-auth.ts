import { type RedditCredentials } from "../secrets.ts";

export const REDDIT_USER_AGENT = "web:aha-openclaw-agent:v0.1.0 (by /u/aha-watch)";
export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
// Renew this long before Reddit's own expiry (about an hour).
export const REDDIT_REFRESH_MARGIN_MS = 60_000;

export type RedditAuth = {
  /** A bearer token valid for at least the refresh margin. */
  token(): Promise<string>;
  /** Drop the cached token, after Reddit answered 401 to it. */
  invalidate(): void;
  /** Only a token for the account (password grant) can post replies. */
  canPost: boolean;
};

export type RedditAuthDeps = { fetch?: typeof fetch; now?: () => number };

export class RedditAuthError extends Error {}

// Access tokens by credential set, shared by the worker's watch and the
// plugin's replies within one process.
const cache = new Map<string, { token: string; expiresAt: number }>();

export function clearRedditTokenCache() {
  cache.clear();
}

/**
 * Reddit OAuth for a "script" app: the password grant when the account's
 * username and password are stored (needed to post), else client_credentials
 * (read-only, enough to search). A bare string is a token stored before
 * credentials were supported; it is used as is and cannot be renewed.
 */
export function redditAuth(secret: string | RedditCredentials | undefined, deps: RedditAuthDeps = {}): RedditAuth | undefined {
  if (!secret) return undefined;
  if (typeof secret === "string") return { token: async () => secret, invalidate() {}, canPost: true };
  const { clientId, clientSecret, username, password } = secret;
  if (!clientId || !clientSecret) return undefined;
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const userGrant = Boolean(username && password);
  const key = `${clientId}:${userGrant ? username : ""}`;
  return {
    canPost: userGrant,
    invalidate() {
      cache.delete(key);
    },
    async token() {
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt - REDDIT_REFRESH_MARGIN_MS) return cached.token;
      const body = userGrant
        ? new URLSearchParams({ grant_type: "password", username: username!, password: password! })
        : new URLSearchParams({ grant_type: "client_credentials" });
      let response: Response;
      try {
        response = await http(REDDIT_TOKEN_URL, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": REDDIT_USER_AGENT,
          },
          body: body.toString(),
        });
      } catch {
        throw new RedditAuthError("reddit token request failed: network");
      }
      // Never include the response body: a failed grant can echo the request.
      if (!response.ok) throw new RedditAuthError(`reddit token request failed: http ${response.status}`);
      const payload = await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
      if (typeof payload.access_token !== "string" || !payload.access_token) {
        throw new RedditAuthError(`reddit token request failed: ${typeof payload.error === "string" ? payload.error : "no access_token"}`);
      }
      const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
      cache.set(key, { token: payload.access_token, expiresAt: now() + expiresIn * 1000 });
      return payload.access_token;
    },
  };
}
