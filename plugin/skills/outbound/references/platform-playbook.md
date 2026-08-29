# Platform Channel — Playbook-Driven In-Platform Outreach

Generic flow for prospects whose channel is `platform` (`platformUrl` = a
posting/listing the project answers in-platform). Everything platform-specific
lives in the project's playbook document, not here (see
`references/workspace-conventions.md` → "Playbook documents").

## 1. Resolve the playbook

Fetch `mcp__plugin_leadace_leadace__get_document` with
`slug: "playbook_<discoveryStrategy>"` (the prospect's `discoveryStrategy`
field). No `discoveryStrategy`, no playbook document, or a playbook the tool
reports as not usable yet (awaiting approval) → **skip the prospect for this
run** and surface it in the run-end report (direct the user to `/leadace` to
define the playbook, or to the Web UI → Documents to approve it); do not
improvise a procedure. Report-only,
no DB write — do not call `skip_prospect` or allocate an outreach row: this is
a config gap, not a per-prospect timing judgment, and a recycle-window stamp
would keep hiding the prospect after the user fixes the playbook. Same shape
as the missing-email-template rule in step 3.

## 2. Compose

Per the playbook's **Outreach** section — a proposal answering the specific
posting, grounded in its content at `platformUrl`, not a generic pitch.

## 3. Allocate the row

`mcp__plugin_leadace_leadace__record_outreach_with_inquiry` with `projectId`,
`prospectId`, `channel: "platform"`, `body` — same two-phase pattern as
form/SNS. Platform messages are solicited in-platform responses, so no
compliance footer is appended: `finalBody` equals the body; submit it as-is.

## 4. Deliver and resolve

- **`pending_review` (draft mode):** stop — the user submits it from
  https://app.leadace.ai/drafts.
- **`pre_send` (send mode):** deliver in-platform per the playbook, normally
  with Claude in Chrome (logged-in profile — same constraint as SNS). Honor
  the playbook's rate limits / ToS; a block, CAPTCHA, or refusal is a failed
  attempt — never bypass it. Always resolve with
  `mcp__plugin_leadace_leadace__update_outreach_status`: success →
  `status: "sent"`; failure or block → `status: "failed"` + a concise
  `errorMessage`.
