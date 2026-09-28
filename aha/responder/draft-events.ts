import { createHash } from "node:crypto";
import { type Store } from "../store/db.ts";

export type DraftEventAction = "drafted" | "edited" | "approved" | "ignored" | "auto_approved"
  | "post_refused" | "posted" | "verified" | "verify_mismatch" | "verify_unavailable" | "uncertain" | "failed";
export type DraftEventDetail = "item_missing" | "unsupported_source" | "not_approved" | "hash_mismatch" | "paused" | "already_posted" | "thread_taken"
  | "cannot_post" | "auth_error" | "network_error" | "response_invalid" | "parent_mismatch" | "body_mismatch"
  | "author_mismatch" | "removed" | "verify_unavailable" | `http_${number}`;

type DraftEvent = {
  draftId: number;
  itemId: number;
  actor: string;
  action: DraftEventAction;
  body?: string;
  detail?: DraftEventDetail;
  at?: Date;
};

export function recordDraftEvent(store: Store, event: DraftEvent) {
  const bodySha256 = event.body === undefined ? null : createHash("sha256").update(event.body).digest("hex");
  const httpStatus = event.detail?.startsWith("http_") ? Number(event.detail.slice(5)) : undefined;
  const safeDetail = httpStatus === undefined || (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
    ? event.detail ?? null
    : null;
  store.db.prepare(`INSERT INTO draft_events (draft_id, item_id, at, actor, action, body_sha256, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(event.draftId, event.itemId, (event.at ?? new Date()).toISOString(), event.actor, event.action, bodySha256, safeDetail);
}
