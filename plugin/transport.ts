/*
 * Checkpoints are per chat; after baseline initialization, progress advances only
 * once a turn finishes, never backwards. Shutdown-interrupted turns stay unacked;
 * terminal failures and uncertain sends are deliberately acknowledged without retry.
 * first:<uid> requests inclusive replay from uid. Recovery and buffered frames
 * dispatch in history order within each chat; stale live frames are ignored.
 * Completed turns have at-least-once recovery across restart: a crash between
 * send and ack can replay at most one completed turn, duplicating its reply.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { on, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export type Member = { type: "member"; uid: string; display_name: string; role: string; provider_key?: string };
export type Agent = { type: "agent"; relationship: string; line: { uid: string; display_name?: string } };
export type Chat = { uid: string; status: string; trusted: boolean; display_name?: string; participants: (Member | Agent)[] };
export type Message = {
  uid: string; direction: string; body: string; sender: Member | Agent; created_at: string;
  attachments: { url: string; content_type: string; filename: string }[];
  reply_to?: Message;
};
export type TurnOutcome = "completed" | "incomplete";
export type Page<T> = { data: T[]; has_more: boolean };
export type Account = { accountId: string; apiBase: string; lineUid: string; emailLineUid?: string };

export class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`Plow HTTP ${status}`); this.status = status; }
}

export class DeliveryUnknownError extends Error {
  constructor() { super("Plow delivery is unknown; stopped to avoid resending"); }
}

export async function request<T>(account: Pick<Account, "apiBase">, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = process.env.PLOW_AGENT_TOKEN;
  if (!token) throw new Error("PLOW_AGENT_TOKEN is required");
  const response = await fetch(`${account.apiBase}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(response.status);
  return await response.json() as T;
}

export function accepts(account: Account, chat: Chat): boolean {
  const line = account.accountId === "email" ? account.emailLineUid : account.lineUid;
  return chat.status === "active" && chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === line);
}

const validChatId = (uid: unknown): uid is string => typeof uid === "string" && uid !== "" && uid !== "." && uid !== "..";

class AmbiguousOwnerChatError extends Error {}

const discoveredChats = new Map<string, Map<string, Chat>>();

export function findOwnerChat(account: Account, chats: Chat[]): Chat | undefined {
  const owners = chats.filter(chat => chat.status === "active" && chat.participants.length === 2 &&
    chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === account.lineUid) &&
    chat.participants.some(p => p.type === "member" && p.role === "owner"));
  if (owners.length > 1) throw new AmbiguousOwnerChatError(`Expected one owner's chat; found ${owners.length}`);
  return owners[0];
}

export async function ownerChat(account: Account): Promise<Chat> {
  const cached = findOwnerChat(account, [...(discoveredChats.get(`${account.apiBase}/${account.lineUid}`)?.values() ?? [])]);
  if (cached) return cached;
  const listing = await request<Page<Chat>>(account, "/chats");
  if (listing.has_more) throw new Error("Cannot resolve owner from a truncated chat listing");
  const chat = findOwnerChat(account, listing.data);
  if (!chat) throw new Error("No owner's chat discovered");
  return chat;
}

// Pages run newest-first; starting_after means older than the page cursor.
// A first:<uid> checkpoint includes that message, but none of its older history.
export async function recover(account: Account, chat: string, checkpoint: string): Promise<Message[]> {
  const missed: Message[] = [];
  let cursor = "";
  for (;;) {
    const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50${cursor ? `&starting_after=${cursor}` : ""}`);
    for (const message of page.data) {
      if (message.uid === checkpoint) return missed.reverse();
      missed.push(message);
      if (`first:${message.uid}` === checkpoint) return missed.reverse();
    }
    if (!page.has_more || !page.data.length) return missed.reverse();
    cursor = page.data.at(-1)!.uid;
  }
}

export async function listen(account: Account, signal: AbortSignal, log: (text: string) => void, turn: (chat: Chat, message: Message, firstContact: boolean, history: Message[]) => Promise<TurnOutcome>) {
  const root = process.env.OPENCLAW_STATE_DIR;
  if (!root) throw new Error("OPENCLAW_STATE_DIR is required");
  const dir = `${root}/plow-checkpoints`;
  await mkdir(dir, { recursive: true });
  const checkpoints = new Map<string, string>();
  const discovered = new Map<string, Chat>();
  if (account.accountId === "chat") discoveredChats.set(`${account.apiBase}/${account.lineUid}`, discovered);
  const seen = new Set<string>();
  const contextualized = new Set<string>();
  let attempt = 0;
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
  };
  const ack = async (chat: string, uid: string) => {
    await writeFile(`${dir}/${encodeURIComponent(chat)}.tmp`, uid);
    await rename(`${dir}/${encodeURIComponent(chat)}.tmp`, `${dir}/${encodeURIComponent(chat)}`);
    checkpoints.set(chat, uid);
  };
  const consume = async (chatUid: string, message: Message, recovered = false) => {
    if (signal.aborted || seen.has(message.uid) || checkpoints.get(chatUid) === message.uid) return;
    // Recovery batches are already ordered after their checkpoint. Live frames
    // can lag behind HTTP history; use that same order before dispatch or ack.
    const checkpointUid = checkpoints.get(chatUid)?.replace(/^first:/, "");
    if (!recovered && checkpointUid && checkpointUid !== message.uid &&
      (await recover(account, chatUid, message.uid)).some(newer => newer.uid === checkpointUid)) return;
    const chat = await request<Chat>(account, `/chats/${chatUid}`);
    if (!accepts(account, chat)) return;
    discovered.set(chat.uid, chat);
    const owner = findOwnerChat(account, [...discovered.values()]);
    const sender = message.sender;
    let notifyFailure = false;
    if (message.direction === "inbound" && (sender.type === "member" || (account.accountId === "chat" && sender.relationship === "peer"))) {
      let outcome: TurnOutcome = "incomplete";
      try {
        const checkpoint = checkpoints.get(chat.uid);
        const firstContact = account.accountId === "chat" && chat.uid === owner?.uid && (checkpoint === "" || checkpoint === `first:${message.uid}`);
        let history: Message[] = [];
        let historyLoaded = contextualized.has(chat.uid);
        if (!historyLoaded) {
          try { history = (await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=20&starting_after=${message.uid}`)).data.reverse(); historyLoaded = true; }
          catch (error) { log(`history failed chat=${chat.uid}: ${(error as Error).name}; dispatching without history`); }
        }
        outcome = await turn(chat, message, firstContact, history);
        if (historyLoaded) contextualized.add(chat.uid);
      }
      catch (error) {
        if (error instanceof DeliveryUnknownError) {
          // The provider may have accepted it; advance rather than replay a send.
          log(`turn failed chat=${chat.uid} message=${message.uid}: delivery unknown; reply suppressed, acknowledging without resending`);
          outcome = "completed";
        } else log(`turn failed chat=${chat.uid} message=${message.uid}: ${(error as Error).name}`);
      }
      if (outcome !== "completed") {
        if (signal.aborted) {
          log(`turn aborted chat=${chat.uid} message=${message.uid}; left unacked`);
          return;
        }
        notifyFailure = true;
        log(`turn incomplete chat=${chat.uid} message=${message.uid}; acknowledging and notifying`);
      }
    }
    if (account.accountId === "chat") await ack(chatUid, message.uid);
    remember(message.uid);
    log(`acked chat=${chatUid} message=${message.uid}`);
    if (notifyFailure) await request(account, `/chats/${chatUid}/messages`, {
      body: "I couldn't finish handling your last message. Part of the request may have already happened, so please check before resending.",
      attachment_uids: [],
    }).catch(error => log(`failure notice failed chat=${chatUid}: ${(error as Error).name}; not retrying`));
  };
  while (!signal.aborted) {
    let socket: WebSocket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const queues = new Map<string, Promise<void>>();
    const slots: (() => void)[] = [];
    let active = 0;
    let accepting = true;
    let queueFailed = false;
    let queueError: unknown;
    const enqueue = (chat: string, work: () => Promise<void>) => {
      const previous = queues.get(chat) ?? Promise.resolve();
      const next = previous.then(async () => {
        if ((!accepting && account.accountId === "chat") || signal.aborted || queueFailed) return;
        if (active === 4) await new Promise<void>(resolve => slots.push(resolve));
        else active++;
        try {
          if ((accepting || account.accountId === "email") && !signal.aborted && !queueFailed) await work();
        } catch (error) {
          queueFailed = true;
          queueError = error;
          socket?.terminate();
        } finally {
          const waiting = slots.shift();
          if (waiting) waiting();
          else active--;
        }
      }).finally(() => {
        if (queues.get(chat) === next) queues.delete(chat);
      });
      queues.set(chat, next);
    };
    const abort = () => {
      // Cancelling a pending upgrade emits an error after the abort listeners are removed.
      if (socket?.readyState === WebSocket.CONNECTING) socket.once("error", () => {});
      socket?.terminate();
    };
    try {
      const { ticket } = await request<{ ticket: string }>(account, "/ws/ticket", {});
      socket = new WebSocket(`${account.apiBase.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`, { handshakeTimeout: 15_000 });
      let unauthorized = false;
      socket.on("unexpected-response", (_request, response) => socket!.emit("error", new HttpError(response.statusCode!)));
      socket.on("close", code => { unauthorized = code === 4401; });
      const frames = on(socket, "message", { signal, close: ["close"] });
      const bufferedChats = new Map<string, Set<string>>();
      const trackBufferedChat = (raw: WebSocket.RawData) => {
        const event = JSON.parse(raw.toString());
        if (event.event_type !== "message_received" || !validChatId(event.chat_id)) return;
        let messages = bufferedChats.get(event.chat_id);
        if (!messages) bufferedChats.set(event.chat_id, messages = new Set());
        messages.add(event.data.message.uid);
      };
      socket.on("message", trackBufferedChat);
      signal.addEventListener("abort", abort, { once: true });
      await once(socket, "open", { signal });
      attempt = 0;
      log(`connected account=${account.accountId}`);
      let alive = true;
      socket.on("pong", () => { alive = true; });
      heartbeat = setInterval(() => {
        if (!alive) socket!.terminate();
        else { alive = false; socket!.ping(); }
      }, 30_000);
      const listing = await request<Page<Chat>>(account, "/chats");
      if (listing.has_more) log("warning: Plow chat listing is truncated; continuing with returned chats");
      const chats = listing.data.filter(chat => validChatId(chat.uid) && accepts(account, chat));
      discovered.clear();
      for (const chat of chats) discovered.set(chat.uid, chat);
      const owner = findOwnerChat(account, chats);
      if (account.accountId === "chat") {
        for (const chat of chats) {
          if (checkpoints.has(chat.uid)) continue;
          let checkpoint: string;
          try { checkpoint = await readFile(`${dir}/${encodeURIComponent(chat.uid)}`, "utf8"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const bufferedBeforeRead = bufferedChats.get(chat.uid)?.values().next().value;
            const page = await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=1`);
            const newest = page.data[0];
            checkpoint = chat.uid === owner?.uid && newest?.direction === "inbound" && newest.sender.type === "member"
              ? `first:${newest.uid}` : newest?.uid ?? "";
            const buffered = bufferedChats.get(chat.uid);
            // HTTP history can include a newer message whose socket frame is delayed.
            // Compare history order when buffer membership cannot order the candidates.
            let first = bufferedBeforeRead ?? (!checkpoint.startsWith("first:") || buffered?.has(newest.uid)
              ? buffered?.values().next().value : undefined);
            const candidate = buffered?.values().next().value;
            if (!first && candidate && checkpoint.startsWith("first:") &&
              (await recover(account, chat.uid, `first:${candidate}`)).some(message => message.uid === newest.uid)) {
              first = candidate;
            }
            if (first) checkpoint = `first:${first}`;
            await ack(chat.uid, checkpoint);
            // Late frames can include an exclusive baseline, but must not replace pending first contact.
            if (!checkpoint.startsWith("first:") && bufferedChats.has(chat.uid)) {
              checkpoint = `first:${bufferedChats.get(chat.uid)!.values().next().value}`;
              await ack(chat.uid, checkpoint);
            }
          }
          checkpoints.set(chat.uid, checkpoint);
        }
      }
      socket.off("message", trackBufferedChat);
      // Retain the finite recovery overlap until this connection closes.
      const replayed = new Set<string>();
      const recoveredChats = new Set<string>();
      const replay = async (chatUid: string) => {
        for (const message of await recover(account, chatUid, checkpoints.get(chatUid)!)) {
          if (!accepting || signal.aborted) break;
          await consume(chatUid, message, true);
          replayed.add(message.uid);
        }
        recoveredChats.add(chatUid);
      };
      if (account.accountId === "chat") {
        for (const chat of chats) enqueue(chat.uid, () => replay(chat.uid));
      }
      for await (const [raw] of frames) {
        const event = JSON.parse(raw.toString());
        if (event.event_type !== "message_received" || !validChatId(event.chat_id) || seen.has(event.event_id) || replayed.has(event.data.message.uid)) continue;
        // Persist discovery before queueing: a dropped connection discards unstarted work.
        if (account.accountId === "chat" && !checkpoints.has(event.chat_id)) {
          let checkpoint: string;
          try { checkpoint = await readFile(`${dir}/${encodeURIComponent(event.chat_id)}`, "utf8"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            checkpoint = `first:${event.data.message.uid}`;
            await ack(event.chat_id, checkpoint);
          }
          checkpoints.set(event.chat_id, checkpoint);
        }
        enqueue(event.chat_id, async () => {
          if (account.accountId === "chat" && !recoveredChats.has(event.chat_id)) {
            await replay(event.chat_id);
          }
          if ((!accepting && account.accountId === "chat") || signal.aborted) return;
          if (!replayed.has(event.data.message.uid)) await consume(event.chat_id, event.data.message);
          remember(event.event_id);
        });
      }
      accepting = false;
      await Promise.all(queues.values());
      if (queueFailed) throw queueError;
      if (unauthorized) throw new HttpError(401);
    } catch (error) {
      accepting = false;
      if (signal.aborted) break;
      if (error instanceof AmbiguousOwnerChatError || (error instanceof HttpError && error.status === 401)) {
        log(error.message + "; stopped until restart");
        clearInterval(heartbeat);
        abort();
        await once(signal, "abort");
        break;
      }
      log(`transport stopped: ${error instanceof HttpError ? error.message : (error as Error).name}`);
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      abort();
      await Promise.all(queues.values());
    }
    if (!signal.aborted) await delay(Math.min(30_000 * 2 ** attempt++, 300_000), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
}
