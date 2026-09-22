import type { Identity } from "./config.ts";

export const probeIdentity: Identity = {
  agent: { name: "Probe" },
  line: { uid: "ln_probe" },
  chats: [{ uid: "cht_probe", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "ln_probe" } },
    { type: "member", uid: "mem_probe", role: "owner" },
  ] }],
};
