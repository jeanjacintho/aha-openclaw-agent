export const MAX_CONSECUTIVE_PEER_TURNS = 3;
export const PEER_LOOP_WINDOW_MS = 10 * 60 * 1000;

export type PeerLoopSender = { type: string; relationship?: string };
type PeerLoopState = { count: number; lastAt: number };

// Allow three peer-triggered turns in a row. The fourth is suppressed until a
// human message arrives, which gives the owner room to intervene in the chat.
export function createPeerLoopGuard(
  limit = MAX_CONSECUTIVE_PEER_TURNS,
  windowMs = PEER_LOOP_WINDOW_MS,
  now: () => number = Date.now,
) {
  const counts = new Map<string, PeerLoopState>();
  return (chatUid: string, sender: PeerLoopSender, log: (text: string) => void) => {
    if (sender.type === "member") {
      counts.delete(chatUid);
      return false;
    }
    if (sender.type !== "agent" || sender.relationship !== "peer") return false;

    const at = now();
    const previous = counts.get(chatUid);
    const previousCount = previous && at - previous.lastAt <= windowMs ? previous.count : 0;
    const next = previousCount + 1;
    if (next <= limit) {
      counts.set(chatUid, { count: next, lastAt: at });
      return false;
    }
    counts.set(chatUid, { count: limit + 1, lastAt: at });
    if (previousCount <= limit) log(`peer loop guard: suppressed peer turn chat=${chatUid} after ${limit} consecutive peer turns`);
    return true;
  };
}
