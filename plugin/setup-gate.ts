import { setupStatus } from "../aha/setup/draft.ts";
import { openStore } from "../aha/store/db.ts";
import type { Chat } from "./transport.ts";

// The Launch watch onboarding gate, run by the channel before the owner's own
// DM turn so the model starts from the setup state instead of having to
// remember to offer setup. Nothing is injected when the gate cannot run; the
// prompt then falls back to aha_status.

// Only the owner's solo DM gets setup: groups and other people's DMs answer
// what was asked and are never interviewed.
export function isOwnerDm(chat: Chat): boolean {
  return chat.participants.length === 2 &&
    chat.participants.some(p => p.type === "agent" && p.relationship === "self") &&
    chat.participants.some(p => p.type === "member" && p.role === "owner");
}

// The owner's phone DM as the hook itself sees it: the gateway can run the
// turn outside the channel's dispatch, so this is the signal a live turn
// carries -- the plow chat account, the one session the owner's DM is bound
// to (boot/config.ts bindings), and a user turn (heartbeats and jobs are not).
export const OWNER_DM_SESSION = "agent:main:main";
export type HookContext = { channel?: string; accountId?: string; sessionKey?: string; trigger?: string };

export function isOwnerDmTurn(ctx: HookContext | undefined): boolean {
  return ctx?.channel === "plow" && (ctx.accountId ?? "chat") === "chat" &&
    ctx.sessionKey === OWNER_DM_SESSION && (ctx.trigger === undefined || ctx.trigger === "user");
}

export function runGate(now = new Date()): string | undefined {
  try {
    const store = openStore();
    try {
      return setupStatus(store, now);
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

export function gateContext(output: string): string {
  return [
    "Launch watch setup gate, already run by the Plow channel for this owner DM turn:",
    "```text", output, "```",
    "Follow the setup rules in AGENTS.md for this state. Do not call aha_status just to check setup.",
  ].join("\n");
}
