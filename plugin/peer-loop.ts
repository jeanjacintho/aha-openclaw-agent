export const MAX_CONSECUTIVE_PEER_TURNS = 3;

export type PeerLoopSender = { type: string; relationship?: string };

// Allow three peer-triggered turns in a row. The fourth is suppressed until a
// human message arrives, which gives the owner room to intervene in the chat.
export function createPeerLoopGuard(limit = MAX_CONSECUTIVE_PEER_TURNS) {
  const counts = new Map<string, number>();
  return (chatUid: string, sender: PeerLoopSender, log: (text: string) => void) => {
    if (sender.type === "member") {
      counts.delete(chatUid);
      return false;
    }
    if (sender.type !== "agent" || sender.relationship !== "peer") return false;

    const previous = counts.get(chatUid) ?? 0;
    const next = previous + 1;
    if (next <= limit) {
      counts.set(chatUid, next);
      return false;
    }
    counts.set(chatUid, limit + 1);
    if (previous <= limit) log(`peer loop guard: suppressed peer turn chat=${chatUid} after ${limit} consecutive peer turns`);
    return true;
  };
}
