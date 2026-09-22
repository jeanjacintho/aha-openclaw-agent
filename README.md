# Plow base image for OpenClaw

This image runs OpenClaw on Plow's cloud host or locally with Docker. You talk to
it on a Plow phone line. It can reply in group threads and its own email threads,
start groups and send follow-ups for the owner, and use the owner's Mac through
Latch, Plow’s Mac app that the owner installs. It uses `z-ai/glm-5.2` through Plow, with `anthropic/claude-sonnet-5` as fallback.

## Run it

Install [plow-agents](https://github.com/plow-pbc/plow-agents), sign in, and choose
an available line. The listing includes the number you will text.

```sh
plow-agents login
plow-agents lines
```

No official image is published yet. For Plow's cloud host, first clone this repo,
then build and push from its root to a registry you control. Authenticate Docker
with that registry and make the image publicly pullable by Plow:

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

Use the full digest reference printed by push and the selected line ID.

To build and run locally, clone this repository and run these commands from its
root. By default, mint writes `plow-credentials` in the current directory;
Compose reads `./plow-credentials` from this repository root:

```sh
plow-agents mint LINE_UID
docker compose up --build -d
docker compose logs -f agent
```

For a local Plow API, use the CLI's `--api-base` option and mint with
`--agent-api-base` set to an address the container can reach, such as
`http://host.docker.internal:PORT`.

Then text the selected number as the owner. Your first message starts the
conversation; no setup greeting is sent before it. Check that a reply arrives.
`docker compose down` keeps the named state volume. `docker compose down -v`
deletes it, so the next boot starts with fresh agent state.

## Behaviour and failures

Set `PLOW_API_BASE` to the API root without `/v1`. Local runs also need
`PLOW_AGENT_TOKEN`; cloud hosts can inject it. Use an API endpoint you control.
Agent state lives in the persistent `/var/lib/plow` volume.

Set `AGENT_ID` to the Agent Index id to put this agent on
[the index](https://aiworthusing.com/agent-index): boot then registers the listing,
with `AGENT_NAME` and `AGENT_BLURB` sent along when they are set, and reports its
token usage every five minutes. The counts come from agentsview, which this
image installs and which reads OpenClaw's own sessions; boot links them where
it looks, since this image moves OpenClaw's state off `~/.openclaw`. The client is
[agent-index-client](https://github.com/plow-pbc/agent-index-client), pinned by
commit and checksum in the `Dockerfile` and fetched at build; its key and ledger live in the state
volume, so a rebuilt container keeps one install rather than registering a second.
Without `AGENT_ID` there is nothing to report for and nothing runs.
`openclaw.json` is boot-owned: runtime config edits (`config set`, `set-identity` emoji/avatar changes, and plugin installs) do not survive a restart.
Workspace `BOOTSTRAP.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` are also boot-owned
and removed at every startup; `AGENTS.md` is boot-rendered.
Do not store durable agent state in these files.

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

## Trust

This agent does not isolate hostile users. Every turn retains its tools; the
model judges authority from the fetched roster, trust flag, conversation and
owner instructions. Only trust people who may use the owner's resources,
including their Mac. Explicit sends can target other served conversations.

Groups use their own history and omit root MEMORY.md. Cross-conversation recall
is disabled, and native session tools cannot read unrelated conversations from
group or peer sessions. Shared files and tools are not privacy boundaries.

## Development

See [development checks and pinned source contracts](DEVELOPMENT.md).
