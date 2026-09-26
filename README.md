# AHA

AHA watches what the public says about a company (and later its competitors),
then texts the owner a daily digest on a Plow phone line. Milestone 1 listens
to **Hacker News** (no key) and **Agent Index comments** (GitHub token required).

It runs on the Plow OpenClaw base (`2026.9.6`). You talk to it by texting the
line. The first owner message starts the conversation; there is no greeting
before that.

## Once (clone and login)

Python 3.11+, Docker, and [plow-agents](https://github.com/plow-pbc/plow-agents)
on `PATH`. Then, once per machine:

```sh
git clone https://github.com/jeanjacintho/aha-openclaw-agent.git
cd aha-openclaw-agent
plow-agents login
```

Text the activation phrase. After that, work from this repository root.

## Install (3 commands)

`plow-agents lines` prints the number you will text and a free `LINE_UID`.

```sh
plow-agents lines
plow-agents deploy --local --line LINE_UID
docker compose logs -f
```

That mints `./plow-credentials` (gitignored), builds the image, and starts the
`agent` service. Compose fails immediately if that credential file is missing.
Text the selected number as the owner and check that a reply arrives.

`docker compose down` keeps the named state volume. `docker compose down -v`
deletes it, so the next boot starts with fresh agent state. When finished:

```sh
plow-agents revoke
docker compose down -v
```

For a local Plow API, pass `--agent-api-base` to `deploy --local` with an
address the container can reach, such as `http://host.docker.internal:PORT`.

### Cloud host

Same three steps after the image is public on a registry you control
(authenticate Docker; Plow pulls anonymously):

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

Use the full digest reference printed by push and a free line ID. Cloud hosts
inject `PLOW_AGENT_TOKEN`; local Compose reads it from `./plow-credentials`.

## Launch watch

Launch watch is the setup for a team that just shipped an agent: **Hacker News
+ Agent Index comments** (`agent:<slug>` discussions on
`plow-pbc/agent-index-comments`). HN needs no key. Agent Index comments need a
**GitHub token** (public-repo read is enough). Without that token, only Hacker
News is watched.

After the container is running, text the line as the owner. Until a watch is
saved, the agent offers setup on its own: before each owner DM turn, the
channel runs a setup gate that tells the model what is recorded and which
question comes next. It asks one question per message: company and domain,
aliases and words that are not you, competitors, sources, tone and language,
then the digest hour. The time zone comes from your Mac through Latch
when connected, and is asked for only when it is not. It then saves setup,
backfills up to 30 days, and sends the first digest to the owner DM. Answers
survive restarts (`setup_draft` in the AHA store). "Not now" pauses the offer
for 24 hours; asking for Launch watch starts it anyway. An install with a saved
watch is never interviewed again. The Agent Index slug is **not** an
interview field: comments use `AGENT_ID` from the environment (`aha` by
default). In the owner DM, set the GitHub token with `aha_secret_set` (never
paste a token in a group).

Suggested answers for Launch watch:

- **Sources:** Hacker News and Agent Index comments
- **Company / product:** the agent or product name as people write it
- **GitHub token:** required for Agent Index comments; set only in the owner DM
- **Product Hunt, GitHub product repos:** later sources; their tokens also go
  through `aha_secret_set` in the owner DM
- **Reddit:** a "script" app from reddit.com/prefs/apps. Give its client id
  and secret to `aha_secret_set` (`source` reddit) in the owner DM; the
  access token is renewed automatically (Reddit's expire in about an hour).
  Add the app account's username and password only to post approved
  replies; without them Reddit is watched but never replied to. Credentials
  are checked with Reddit before they are saved.

At the end of setup the agent asks for the credentials the chosen sources
still need (`needsCredentials` from `aha_setup_save`).

Any member may ask `aha_status`. Only the owner can save setup, set secrets, or
run a backfill.

## Site watch

Besides the API sources above, the owner can point AHA at specific pages
through `aha_sites_add({url, label?, mode?})` — a competitor's blog, a
changelog, an X/Twitter profile. This is **not** a search of the open web:
only the exact URLs the owner registers are ever visited, once a day, through
the owner's Mac (Latch). It is a command, not a setup interview question, so
it never lengthens Launch watch.

- `mode` is `mentions` (default: only new content that mentions the company
  or a configured competitor) or `all` (every new block on the page).
  `aha_sites_remove` and `aha_sites_list` manage the list; any member may
  list, only the owner may add or remove.
- The cycle runs once a day, an hour before the digest, so a new mention makes
  that day's digest. It reads each page's text and links, and reports only
  what is new since the last visit; the first visit after a site is added is
  a silent baseline, so it never dumps a page's whole back-catalog into the
  digest.
- Page content is untrusted data, exactly like any other public mention:
  never followed as an instruction.
- The Mac needs to be reachable through Latch at that hour. When it is not —
  asleep, disconnected, or an origin the owner has not approved — that day's
  run for the affected site(s) is recorded as `degraded` (see
  `aha_sites_list` and `aha_status`) and the 15-minute API polling above is
  unaffected. The next day tries again; nothing is retried in a loop.
- Known limitation: reading is deterministic (no model drives the browser),
  so a page that needs a login, infinite scroll, or heavy interaction to show
  its content may not extract anything useful. It still shows as `degraded`
  rather than silently missing content.

## Agent Index identity

Boot registers on [the Agent Index](https://aiworthusing.com/agent-index) and
reports token usage every five minutes when `AGENT_ID` is set. Counts come from
agentsview (OpenClaw sessions) plus the worker ledger. The client is
[agent-index-client](https://github.com/plow-pbc/agent-index-client), pinned in
the `Dockerfile`; its key lives on the state volume so a rebuilt container
keeps one install.

These are environment variables (Compose substitutes from the shell or a `.env`
file next to `compose.yml`; the image also bakes the same defaults):

| Variable | Default | Role |
|---|---|---|
| `AGENT_ID` | `aha` | Index listing id, and the slug watched for `agent:<slug>` comments. |
| `AGENT_NAME` | `AHA` | Sent on first register only, when set. |
| `AGENT_BLURB` | see `compose.yml` / `Dockerfile` | Same: sent on first register only, when set (keep ≤ 140 characters). |

Compose uses `${AGENT_ID-aha}`: **unset** becomes `aha`; an explicit empty
`AGENT_ID=` stays empty and skips register and report (that empty value also
overrides the image default). `${AGENT_ID:-aha}` would turn an empty value
into `aha`, so it is not used.

Override without rebuilding, for a local run:

```sh
export AGENT_ID=aha AGENT_NAME=AHA AGENT_BLURB='Watches public mentions of your company. Hacker News and Agent Index comments, then a daily digest on Plow.'
plow-agents deploy --local --line LINE_UID
```

Name and blurb are sent only when registering a new install. Later edits on the
Index page are not overwritten every pass. `PLOW_API_BASE` is the API root
without `/v1`. Set `PLOW_AGENT_TOKEN` locally; cloud hosts can inject it.

`openclaw.json` is boot-owned: runtime config edits (`config set`, `set-identity` emoji/avatar changes, and plugin installs) do not survive a restart.
Workspace `BOOTSTRAP.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` are also
boot-owned and removed at every startup; `AGENTS.md` is boot-rendered. Do not
store durable agent state in these files. Durable AHA state is SQLite under
`/var/lib/plow/aha/` (override with `AHA_HOME` in tests).

## Behaviour and failures

Set `PLOW_API_BASE` to the API root without `/v1`. Local runs also need
`PLOW_AGENT_TOKEN`; cloud hosts can inject it. Use an API endpoint you control.
Agent state lives in the persistent `/var/lib/plow` volume.

The gateway starts after one bounded identity lookup, even before the owner has a
chat. Identity lookup tolerates 401/403 for 120 seconds and retries network/429/5xx
failures ten times. Invalid identity or exhausted boot retries leave the
container running with a diagnostic error. The plugin subscribes before listing
chats, discovers the active owner DM from its roster, and buffers messages during
baseline recovery. Multiple owner DMs among the received listing and live chats
stop the chat account until the container restarts. A cached owner may be used
from a truncated listing; uniqueness is checked only among discovered chats.
Without a cached owner, the fallback lookup refuses truncated listings.
The API currently returns complete listings.
Socket drops reconnect with backoff; the plugin never re-reads identity.

Without a checkpoint, an earlier owner-DM message buffered during baseline recovery runs first.
Otherwise, the newest inbound member message is first contact, even if sent before the plugin connects.
Chat checkpoints survive restarts. Chats omitted from a truncated listing
recover on their first live frame. Optional history failures still dispatch the
current message. Email threads have separate sessions, shared by their senders,
but no history backfill. The owner's phone DM uses the main session; other DMs
and groups have separate sessions.

Shutdown-interrupted chat turns can recover. Incomplete live turns are logged
and acknowledged, with one neutral notice that the request may have partly
happened. A failed or uncertain notice is not retried. An ambiguous delivery is
not retried; a crash after sending but before checkpointing can duplicate a reply.

Replies stay in their source conversation. The agent can start trusted groups
with the owner and send follow-ups to active conversations on its own lines.
Clarifications are ordinary replies. When connected through Latch, the owner's
Mac provides its tools and instructions. Mac unavailability does not prevent
texting. Long-running MCP responses stream without a fixed bridge timeout;
client disconnects cancel the upstream request. A bridge crash restarts the
bridge while the gateway continues.

Public mention text is data, never instructions. The worker classify/LLM path
runs without tools; invalid model output goes to `needs_review`.

## Trust

This agent does not isolate hostile users. Every turn retains its tools; the
model judges authority from the fetched roster, trust flag, conversation and
owner instructions. AHA tools that change state also check the requester in
code: only the owner can save setup, set secrets, or backfill. Only trust
people who may use the owner's resources, including their Mac. Explicit sends
can target other served conversations.

Groups use their own history and omit root MEMORY.md. Cross-conversation recall
is disabled, and native session tools cannot read unrelated conversations from
group or peer sessions. Shared files and tools are not privacy boundaries.

## Development

See [development checks and pinned source contracts](DEVELOPMENT.md).
