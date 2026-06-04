---
name: check-responses
description: "This skill should be used when the user asks to \"check replies\", \"check responses\", \"see results\", \"check if there are email replies\", or wants to check outbound outreach responses. Automatically checks email replies and SNS responses and records them in the DB."
argument-hint: "<project-id>"
allowed-tools:
  - Bash
  - Read
  - mcp__claude_ai_Gmail__search_threads
  - mcp__claude_ai_Gmail__get_thread
  - mcp__claude-in-chrome__tabs_context_mcp
  - mcp__claude-in-chrome__tabs_create_mcp
  - mcp__claude-in-chrome__navigate
  - mcp__claude-in-chrome__read_page
  - mcp__claude-in-chrome__get_page_text
  - mcp__claude_ai_Gmail__create_draft
  - mcp__plugin_leadace_api__get_recent_outreach
  - mcp__plugin_leadace_api__record_response
  - mcp__plugin_leadace_api__update_prospect_status
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__get_master_document
---

# Check Responses - Response Collection

A skill that automatically checks outbound sales responses and records them in the database.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Setup

- Project ID: `$0` (required)

In parallel, call:
- `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"`
- `mcp__plugin_leadace_api__get_master_document` with `slug: "ref_scheduling_services"` (canonical service-name → notification-domain mapping)

From the "Response Definition" section of SALES_STRATEGY.md, understand:
- What counts as a "response"
- Scheduling service(s) in use (service names — there may be multiple, e.g. one for global team, one for a regional team)
- Other response signals

**Resolve scheduling notification domains:** for each scheduling service named in SALES_STRATEGY.md, look up its domain(s) in the `ref_scheduling_services` reference. If SALES_STRATEGY also has an explicit sender address (legacy format like "Timerex — notifications@timerex.net"), extract just the domain. If the service is not in the reference and SALES_STRATEGY has no sender address, skip the scheduler search for that service and report it in step 7.

### 2. Retrieve Recent Outreach Information

Retrieve metadata for outreach sent within the last 4 business days:

Call `mcp__plugin_leadace_api__get_recent_outreach` with `projectId: "$0"`.

If the tool returns a "Project not found" error, instruct the user to run `/leadace` first and **abort**.

Each log carries recipient identifiers — `prospectName`, `contactName` (nullable), `prospectEmail` (nullable), `organizationDomain` — use these directly for the domain-search step below and for naming prospects in the report; do not infer from message bodies.

Each log also includes inquiry-landing aggregates: `inquirySessionCount`, `inquiryOutcome` (`opened` / `inquired` / `lead` / `signup_clicked` / `unsubscribed` / null — the most-significant outcome ever recorded for this outreach, so a recipient who converts and later re-visits the link is still reported as the converted outcome), `inquiryMeetingSource` (`button` / `chat` / null — only set when `inquiryOutcome === 'lead'`), `inquiryLastVisitAt`. Inquiry-derived `lead`, `signup_clicked`, and `unsubscribed` outcomes are recorded server-side at the moment the recipient acts on the landing page — the skill only **surfaces** them in the report, it does not re-record them. `lead` is the human-sales conversion (recipient asked to talk); `signup_clicked` is the self-serve conversion (recipient opened the project's signup URL — visible only when the project's CTA mode is `signup`, no human follow-up needed).

### 3. Check Incoming Emails

Use Gmail MCP to perform the following searches:

**3a. Search for Direct Replies**

For each outreach-targeted prospect, search by the **domain** of the email address sent to (to handle replies from different people in the same organization):

1. Search `mcp__claude_ai_Gmail__search_threads` for `from:@<domain> newer_than:4d`
2. If found, confirm content with `mcp__claude_ai_Gmail__get_thread`
3. Determine whether the content is a response to the outreach

**3b. Search for Scheduling Notifications**

For each scheduling service domain resolved in step 1, search Gmail. Run searches for all configured services in parallel (e.g. one for Calendly, one for SavvyCal if both are in use):

1. Search `mcp__claude_ai_Gmail__search_threads` for `from:<domain> newer_than:4d` (e.g. `from:calendly.com newer_than:4d`). Substring match catches subdomains (`@email.calendly.com` etc.)
2. If found, read the content and match the name, email address, and organization name in the notification body against the outreach list
3. Domain match alone is insufficient — the body must reference an outreach prospect (the same domain may carry unrelated mail like service marketing emails)

**3c. Search for Bounced Emails**

Detect sending failures (unknown recipient, non-existent domain, etc.):

1. Search `mcp__claude_ai_Gmail__search_threads` for `from:mailer-daemon OR from:postmaster newer_than:4d`
2. If found, confirm content with `mcp__claude_ai_Gmail__get_thread`
3. Match the bounced email address against the outreach list to identify the corresponding prospect

**3d. Matching**

Link received emails to outreach prospects. Match in the following priority order:
1. **Exact match on sent address**: Direct reply from the recipient
2. **Domain match**: Reply from a different person in the same organization (e.g., sent to `contact@example.com` -> received from `alex@example.com`)
3. **Organization name match**: The prospect's `name` appears in the email body or sender name (handles replies from group companies or legal secretariats)
4. **Scheduling notification**: The notification email body contains the prospect's name or email address

If match confidence is low, note "Needs confirmation" in the report and defer to the user's judgment.

### 4. Check SNS Responses

**Prerequisite check:** If the `recent-outreach` result from step 2 has **no SNS channel outreach** (`sns_twitter` / `sns_linkedin`), **skip this entire step**.

Check for DM replies from prospects contacted via SNS using claude-in-chrome. Supported platforms: **X (Twitter)** and **LinkedIn**.

**For X (Twitter):**
1. Open the X DM screen (https://x.com/messages)
2. Check for replies from outreach targets
3. If there are replies, retrieve the content

**For LinkedIn:**
1. Open the LinkedIn messaging screen (https://www.linkedin.com/messaging/)
2. Check for replies from outreach targets
3. If there are replies, retrieve the content

**If the browser extension is not connected:** Skip SNS checking, but count the number of prospects contacted via SNS that remain unconfirmed. In the results report (step 7), always report this as "**Unconfirmed SNS DMs: N**".

### 5. Update Database

For each response found, call `mcp__plugin_leadace_api__record_response` with:
- `outreachLogId`: the matching outreach log ID from step 2
- `channel`: the channel the response came through
- `content`: the response content
- `sentiment`: `positive` / `neutral` / `negative`
- `responseType`: `reply` / `auto_reply` / `bounce` / `meeting_request` / `rejection`
- `markDoNotContact`: set `true` for bounces or explicit opt-out requests
- `receivedAt`: ISO 8601 timestamp if known
- `rejectionFeedback`: **only when `responseType` is `rejection`** -- best-effort structured reason inferred from the body. See "Rejection feedback inference" below.

The server automatically determines the prospect status update based on `responseType` and `sentiment`:
- Positive reply / meeting_request -> `responded`
- Rejection -> `rejected`
- Bounce -> `inactive` (also auto-marks do-not-contact)
- Auto-reply -> no status change (keeps `contacted`)

**Do-not-contact determination**: If the reply content contains opt-out intent such as "no further contact needed", "unsubscribe", "please don't contact me", set `markDoNotContact: true`. This applies across all projects.

If they simply declined this project's proposal (e.g., "we'll pass this time"), the server sets `rejected` via the responseType -- do not set `markDoNotContact`.

**Edge case override**: If the automatic status is incorrect (e.g., a negative-sentiment reply that's actually a "not now, try again later"), use `mcp__plugin_leadace_api__update_prospect_status` to set the correct status.

#### Rejection feedback inference

When `responseType` is `rejection`, also pass `rejectionFeedback` to capture the structured reason. The server uses this for `/check-feedback` aggregation (especially `feature_gap` notes which are PMF signal) and auto-flips `do_not_contact` for unsubscribe / GDPR / CCPA / "never" recontact intents.

Schema URI: `https://leadace.ai/schema/rejection-feedback-v1.json`

Pick `primary_reason` from the body — choose the single best fit:

| value | when to pick it |
|---|---|
| `not_relevant` | Content/role mismatch ("not what we do", "wrong department") |
| `wrong_timing` | Interested but not now ("come back next quarter", "busy season") |
| `budget` | Money is the blocker ("no budget", "next fiscal year") |
| `feature_gap` | Specific missing capability ("we'd need X integration", "no SSO support") -- **highest PMF value, prefer over `not_relevant` when a concrete feature is named** |
| `already_have_solution` | Existing tool covers it ("we use Foo already") |
| `competitor_locked` | Multi-year contract / renewal-only window |
| `not_decision_maker` | Forwarding to someone else / "not my call" |
| `unsubscribe_request` | Explicit "remove me" / "stop emailing" / "opt out" |
| `other` | None of the above clearly fit, or confidence is low |

Optional fields to fill when the body supports them:
- `secondary_reasons`: up to 5 additional values from the same enum, only if multiple are clearly stated
- `free_text`: short note (≤ 500 chars). Use the original-language body excerpt (≤ 200 chars). For `primary_reason: 'other'`, always include this so the reason isn't lost
- `preferred_recontact_window`: one of `'never'` / `'3_months'` / `'6_months'` / `'12_months'` / `'unspecified'`. **Pick `'unspecified'` whenever the body
  signals "later" / "not now" without committing to a concrete date** ("come back later", "maybe next year", "we'll reach out when
  ready"). Only pick a concrete window when the recipient names one. Don't drop the field — leaving it null when the recipient said
  "later" loses the deferral and the prospect re-enters the pool immediately. The server resolves `'unspecified'` to the project's
  `unspecified_recontact_window_months` setting (default 3 months)
- `decision_maker_pointer`: `{ name?, email?, role? }` -- only when the body literally points to another contact ("contact alex@... for this", "speak to our CTO")
- `consent`: `{ gdpr_erasure_request, ccpa_opt_out, marketing_opt_out }` -- set the relevant boolean to `true` when the body invokes the corresponding right
- `submitted_at`: ISO 8601 of `received_at` (or `new Date().toISOString()` if unknown)
- `version`: always `1`

**When to omit `rejectionFeedback`**: if `responseType !== 'rejection'`, omit it entirely (the server returns 400 if you pass it).

**DNC interaction**: setting `primary_reason: 'unsubscribe_request'`, `preferred_recontact_window: 'never'`, or any `consent.*: true` automatically forces `do_not_contact = true` even if you didn't pass `markDoNotContact: true`. You can still pass `markDoNotContact` explicitly for plain "stop emailing me" with no structured form.

### 6. Create Reply Drafts

If step 5 recorded a positive response (`responded`) for any prospect, use Gmail MCP to automatically create a reply draft.

**Scope:** Only replies with positive or neutral sentiment and response_type of `reply` or `meeting_request`. Bounces, auto-replies, and rejections are excluded.

**Skip inquiry-derived leads and signups.** If a prospect's `inquiryOutcome` is `lead` or `signup_clicked` and there is no matching Gmail / SNS reply found in step 5, skip draft creation for that prospect — there is no email thread to reply to. For `lead`, the project owner has already received a self-notification email; for `signup_clicked`, the recipient is now in the SaaS product's own signup flow and any follow-up should come from there, not from a sales reply. Surface both in step 7's report instead.

**Draft creation steps:**

1. Refer to the "Messaging" section of `$0/SALES_STRATEGY.md` for tone and structure, and the "Sender Information" section for the signature block to append (sender display name and email come from project settings — Gmail MCP creates drafts in the user's own account, so they're not needed as arguments here)
2. Create an appropriate draft based on the reply content:
   - **Positive reply (interested)** -> Thank you + scheduling link or 3 time slot options
   - **Material request** -> Thank you + note that materials will be sent (the user will attach the actual materials after the draft)
   - **Question / inquiry** -> Draft answer to the question + next step suggestion
   - **Scheduling confirmation** -> Thank you for confirming + details for the day
3. Create the draft with `mcp__claude_ai_Gmail__create_draft`. Set subject in reply format (`Re: {original subject}`)
4. Include the number of drafts created in the results report

**Note:** Do not send automatically. Only create drafts; sending is done manually by the user after reviewing the content. If draft creation fails (Gmail MCP not connected, etc.), skip and report in the report.

### 7. Results Report

Report the following:
- Number of prospects checked
- Number of prospects with responses and breakdown (positive/neutral/negative)
- Response rate (responses / approaches)
- Response type breakdown (direct reply / scheduling confirmation, etc.)
- List any low-confidence matches as "Needs confirmation"
- **Unconfirmed SNS DMs: N** (when SNS checking was skipped; report even if 0)
- **Reply drafts created: N** (number created in step 6; report even if 0. If drafts exist, guide the user to check Gmail drafts)
- Summary of notable replies
- Guide the user to run `/evaluate` as the next step
- If any `rejection` responses with PMF-relevant reasons (`feature_gap` / `already_have_solution` / `competitor_locked`) were recorded in step 5, also mention: "`/check-feedback` surfaces PMF signals from rejection feedback (feature gaps, competitor presence)." Do not mention `/check-feedback` for any other rejection reasons — non-PMF signals (tactical, unsubscribe, other) will be consumed by `/evaluate` automatically.

**Inquiry landing section** (only when at least one log has `inquirySessionCount > 0`):
- **Lead via inquiry landing: N** — call out this number first and prominently when ≥ 1, since these are high-signal recipients who explicitly asked to talk. For each lead include `prospectName` (and `contactName` when set), `prospectEmail` if present otherwise `organizationDomain`, `inquiryMeetingSource` (button / chat), and `inquiryLastVisitAt`. The project owner has already been notified by email at the moment of conversion, but surfacing them here keeps the daily report self-contained.
- **Signup via inquiry landing: N** — call out separately when ≥ 1 (only relevant when the project runs in `signup` CTA mode). These are recipients who opened the project's signup URL; no human follow-up is expected, but track count for self-serve conversion measurement. For each include `prospectName` (and `contactName` when set), `prospectEmail` if present otherwise `organizationDomain`, and `inquiryLastVisitAt`.
- **Visits / inquired / unsubscribed via chip** — short counts grouped under "Inquiry landing activity":
  - Visits: total prospects with `inquirySessionCount > 0`
  - Inquired (chat used, no lead/signup): `inquiryOutcome === 'inquired'`
  - Unsubscribed via chip: `inquiryOutcome === 'unsubscribed'`
- Do **not** echo chat message bodies in the report. Surface only the aggregates above. (Chat-content visibility on the sender side is gated on a separate compliance review.)

Append a single low-key dashboard line at the end: `Dashboard: https://app.leadace.ai/responses` — purely informational, do not push the user to open it.

Report directly to the user (no file output needed -- response data is stored in the DB).
