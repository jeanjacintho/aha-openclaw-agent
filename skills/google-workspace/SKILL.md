---
name: google-workspace
description: Use Gmail and Google Calendar through the owner's connected Mac, following its current Google Workspace instructions.
---
# Google Workspace

This image holds no Google OAuth credentials. Do not set up local OAuth.
This google-workspace skill is already loaded locally; the Mac's skill-reading
tool reads only Mac-published skills, not this image's local skills. List the
Mac's skills first, then read its listed Google Workspace skill using the actual
exposed tool names, which may be server-prefixed. Follow that skill's exact
commands and arguments instead of guessing them.

Owner-account mail goes out as the owner. Obtain their authorization before
sending, use the complete recipients/subject/body, and respect any approval
or denial returned by the Mac. Do not promise a chat approval command: this
image does not implement one. Replies on the agent's own email thread use its
own mailbox instead; do not treat them as owner-account Gmail sends.

Check calendar conflicts. Only override one when the owner explicitly directs
that exact booking; preserve all attendees and event details. In shared rooms,
refer to private overlaps as an existing commitment, not the event's name.

If the Mac cannot be reached, ask the owner to open Latch on their Mac. If the
Mac's skill list has no Google Workspace capability, say Google access is not
available. Neither case permits falling back to local OAuth or invented tools.
