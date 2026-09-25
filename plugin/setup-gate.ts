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

// The owner's phone DM as the hook itself sees it. The gateway runs the turn
// from its ingress queue, outside the channel's dispatch, so the channel's own
// turn state is not there. boot/config.ts binds only the owner's phone DM to
// the main session; heartbeats and jobs share that session but not the user
// trigger. The channel and account fields are not required: OpenClaw fills
// them differently per run path, and a live owner turn arrived without the
// values this check used to demand.
export const OWNER_DM_SESSION = "agent:main:main";
export type HookContext = { channel?: string; accountId?: string; sessionKey?: string; trigger?: string };

export function isOwnerDmTurn(ctx: HookContext | undefined): boolean {
  return ctx?.sessionKey === OWNER_DM_SESSION && (ctx.trigger === undefined || ctx.trigger === "user") &&
    (ctx.accountId === undefined || ctx.accountId === "chat");
}

// A user turn in the owner's session that the gate still left out is a bug:
// say so, with the fields that decided it and no sender identifiers.
export function skipReason(ctx: HookContext | undefined, inDispatch: boolean): string | undefined {
  if (ctx?.sessionKey !== OWNER_DM_SESSION || (ctx.trigger !== undefined && ctx.trigger !== "user")) return;
  const fields = { channel: ctx.channel, accountId: ctx.accountId, trigger: ctx.trigger, sessionKey: ctx.sessionKey, inDispatch };
  return `aha setup gate skipped: ${JSON.stringify(fields)}`;
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
