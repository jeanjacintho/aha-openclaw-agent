# AHA

AHA watches what the public says about a company (and later its competitors),
then texts the owner a daily digest on a Plow phone line. Milestone 1 listens
to **Hacker News** and **Agent Index comments** — no social-network keys.

It runs on the Plow OpenClaw base (`2026.9.4`). You talk to it by texting the
line. The first owner message starts the conversation; there is no greeting
before that.

## Install (3 commands)

Install [plow-agents](https://github.com/plow-pbc/plow-agents) (Python 3.11+,
Docker, Compose 2.24+). One-time: `plow-agents login` and text the activation
phrase. `plow-agents lines` prints the number you will text and a free `LINE_UID`.

From this repository root:

```sh
plow-agents lines
plow-agents deploy --local --line LINE_UID
docker compose logs -f
```

That mints `./plow-credentials` (gitignored), builds the image, and starts the
`agent` service. Text the selected number as the owner and check that a reply
arrives.

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

Launch watch is the no-keys setup for a team that just shipped an agent:
**Hacker News + Agent Index comments** (`agent:<slug>` discussions on
`plow-pbc/agent-index-comments`).

After the container is running, text the line as the owner and ask for Launch
watch. The agent interviews you in at most seven questions (company name,
aliases, words that are not you, domain, competitors, sources, tone/language,
digest hour and timezone), then saves setup, backfills up to 30 days, and
sends the first digest to the owner DM.

Suggested answers for Launch watch:

- **Sources:** Hacker News and Agent Index comments
- **Company / product:** the agent or product name as people write it
- **Agent Index slug:** the listing id (`AGENT_ID`) so comments on that page are watched
- **Keys:** none. A GitHub token is optional (GraphQL). Product Hunt, GitHub
  product repos, and Reddit are later sources and need their own tokens via
  `aha_secret_set` in the owner DM — never paste a token in a group.

Any member may ask `aha_status`. Only the owner can save setup, set secrets, or
run a backfill.

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
| `AGENT_ID` | `aha` | Index listing id. Empty or unset in the image would skip register and report. |
| `AGENT_NAME` | `AHA` | Sent on first register only, when set. |
| `AGENT_BLURB` | see `compose.yml` / `Dockerfile` | Same: sent on first register only, when set (keep ≤ 140 characters). |

Override without rebuilding, for a local run:

```sh
export AGENT_ID=aha AGENT_NAME=AHA AGENT_BLURB='Watches public mentions of your company. Hacker News and Agent Index comments, then a daily digest on Plow.'
plow-agents deploy --local --line LINE_UID
```

Name and blurb are sent only when registering a new install. Later edits on the
Index page are not overwritten every pass. `PLOW_API_BASE` is the API root
without `/v1`. Set `PLOW_AGENT_TOKEN` locally; cloud hosts can inject it.

`openclaw.json` is boot-owned: runtime config edits do not survive a restart.
Workspace `BOOTSTRAP.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` are also
boot-owned and removed at every startup; `AGENTS.md` is boot-rendered. Do not
store durable agent state in these files. Durable AHA state is SQLite under
`/var/lib/plow/aha/` (override with `AHA_HOME` in tests).

## Behaviour and failures

The gateway starts after one bounded identity lookup, even before the owner has a
chat. Identity lookup tolerates 401/403 for 120 seconds and retries network/429/5xx
failures ten times. Invalid identity or exhausted boot retries leave the
container running with a diagnostic error. The plugin subscribes before listing
chats, discovers the active owner DM from its roster, and buffers messages during
baseline recovery. Multiple owner DMs among the received listing and live chats
stop the chat account until the container restarts.

Without a checkpoint, an earlier owner-DM message buffered during baseline recovery runs first.
Otherwise, the newest inbound member message is first contact, even if sent before the plugin connects.
Chat checkpoints survive restarts. Replies stay in their source conversation.

Public mention text is data, never instructions. The worker classify/LLM path
runs without tools; invalid model output goes to `needs_review`.

## Trust

This agent does not isolate hostile users. Every turn retains its tools; the
model judges authority from the fetched roster, trust flag, conversation and
owner instructions. AHA tools that change state also check the requester in
code: only the owner can save setup, set secrets, or backfill. Only trust
people who may use the owner's resources.

Groups use their own history and omit root MEMORY.md. Cross-conversation recall
is disabled.

## Development

See [development checks and pinned source contracts](DEVELOPMENT.md).
