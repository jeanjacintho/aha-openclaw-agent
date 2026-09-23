import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type ExportResult = { sessions: number; added: number; errors: string[] };

type TranscriptRow = { session_id: string; seq: number; event_json: string };

/** A session id becomes a file name. These would leave the output directory. */
function unsafe(id: string) {
  return id.includes("/") || id.includes("\\") || id.includes("..") || id.startsWith(".");
}

/** The reporter's ~/.openclaw/agents. A symlink left by the base image is the link itself, never its target. */
export function prepareOutputRoot(outRoot: string) {
  try {
    if (lstatSync(outRoot).isSymbolicLink()) unlinkSync(outRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(outRoot, { recursive: true });
}

function eventId(eventJson: string, sessionId: string, seq: number) {
  try {
    const id = JSON.parse(eventJson).id;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // A line that is not JSON still needs a stable key so a later pass does not append it again.
  }
  return `${sessionId}:${seq}`;
}

function readLines(file: string) {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const ids = new Set<string>();
    for (const line of lines) {
      try {
        const id = JSON.parse(line).id;
        if (typeof id === "string") ids.add(id);
      } catch {
        // Kept as-is. An unparseable line is not a reason to drop history.
      }
    }
    return { lines, ids };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [] as string[], ids: new Set<string>() };
    throw error;
  }
}

/** Append events by id. A header is written once. Lines already in the file stay, in order. */
export function writeSession(file: string, events: string[], header?: string) {
  const prior = readLines(file);
  const lines = [...prior.lines];
  const ids = new Set(prior.ids);
  if (header && !lines.some(line => {
    try { return JSON.parse(line).type === "session"; } catch { return false; }
  })) lines.unshift(header);
  let added = 0;
  for (const event of events) {
    let id = "";
    try { id = JSON.parse(event).id ?? ""; } catch { id = ""; }
    if (!id || ids.has(id)) continue;
    lines.push(event);
    ids.add(id);
    added += 1;
  }
  if (lines.length !== prior.lines.length) writeAtomic(file, lines);
  return { added };
}

function writeAtomic(file: string, lines: string[]) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function oneLine(eventJson: string) {
  return eventJson.includes("\n") ? JSON.stringify(JSON.parse(eventJson)) : eventJson;
}

export function exportOpenClawSessions(stateDir: string, outRoot: string): ExportResult {
  const errors: string[] = [];
  let sessions = 0;
  let added = 0;
  try {
    prepareOutputRoot(outRoot);
    let agents: string[];
    try {
      agents = readdirSync(`${stateDir}/agents`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: 0, added: 0, errors: [`no OpenClaw session database under ${stateDir}`] };
      }
      throw error;
    }
    const databases = agents.filter(agent => !unsafe(agent)).map(agent => ({
      agent,
      file: `${stateDir}/agents/${agent}/agent/openclaw-agent.sqlite`,
    }));
    if (databases.length === 0) return { sessions: 0, added: 0, errors: [`no OpenClaw session database under ${stateDir}`] };
    for (const { agent, file } of databases) {
      let present = false;
      try { present = lstatSync(file).isFile(); } catch { present = false; }
      if (!present) {
        errors.push(`no OpenClaw session database at ${file}`);
        continue;
      }
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(file, { readOnly: true });
        const rows = db.prepare("SELECT session_id, seq, event_json FROM transcript_events ORDER BY session_id, seq").all() as TranscriptRow[];
        const bySession = new Map<string, TranscriptRow[]>();
        for (const row of rows) {
          const list = bySession.get(row.session_id) ?? [];
          list.push(row);
          bySession.set(row.session_id, list);
        }
        for (const [sessionId, events] of bySession) {
          if (unsafe(sessionId)) {
            errors.push(`refusing session id ${sessionId}`);
            continue;
          }
          sessions += 1;
          const dest = `${outRoot}/${agent}/sessions/${sessionId}.jsonl`;
          mkdirSync(`${outRoot}/${agent}/sessions`, { recursive: true });
          const prior = readLines(dest);
          let grew = 0;
          for (const event of events) {
            const id = eventId(event.event_json, sessionId, event.seq);
            if (prior.ids.has(id)) continue;
            prior.lines.push(oneLine(event.event_json));
            prior.ids.add(id);
            grew += 1;
          }
          if (grew > 0) writeAtomic(dest, prior.lines);
          added += grew;
        }
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        db?.close();
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { sessions, added, errors };
}
