---
name: outbound
description: "This skill should be used when the user asks to \"send emails\", \"do outreach\", \"contact prospects\", \"run outbound sales\", or wants to execute outbound sales. Automatically sends emails, fills in contact forms, and sends SNS DMs to prospects on the list. Count can be specified."
argument-hint: "<project-id> [count]"
allowed-tools:
  - Bash
  - Read
  # claude-in-chrome handles both contact-form submission and SNS DMs
  - mcp__claude-in-chrome__tabs_context_mcp
  - mcp__claude-in-chrome__tabs_create_mcp
  - mcp__claude-in-chrome__navigate
  - mcp__claude-in-chrome__read_page
  - mcp__claude-in-chrome__find
  - mcp__claude-in-chrome__get_page_text
  - mcp__claude-in-chrome__form_input
  - mcp__claude-in-chrome__computer
  - mcp__claude-in-chrome__javascript_tool
  - mcp__claude-in-chrome__read_network_requests
  - mcp__plugin_leadace_api__get_outbound_targets
  - mcp__plugin_leadace_api__send_email_and_record
  - mcp__plugin_leadace_api__skip_prospect
  - mcp__plugin_leadace_api__record_outreach_with_inquiry
  - mcp__plugin_leadace_api__update_outreach_status
  - mcp__plugin_leadace_api__update_prospect_status
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__get_master_document
  - mcp__plugin_leadace_api__get_project_settings
  - mcp__plugin_leadace_api__get_gmail_status
  - mcp__plugin_leadace_api__pick_subject_variant
  - mcp__plugin_leadace_api__get_compliance_status
---

# Outbound - Outbound Sales Execution

A skill that sequentially reaches out to prospects on the sales list via email, contact forms, and SNS DMs.

For each prospect, sends a message via an available channel and records the result in the DB. After all processing, generates a summary report.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Setup

- Project ID: `$0` (required)
- Approach count: `$1` (default: 30)

**Compliance pre-flight (run before anything else).** Call
`mcp__plugin_leadace_api__get_compliance_status`. If `ready: false`,
**abort immediately** — do not load documents, do not call
`get_outbound_targets`. Report to the user which fields are missing
(from the `missing` array) and direct them to the URL in `fix_url`
(e.g. `https://app.leadace.ai/workspace-settings`). Tell them to re-run
this skill once the workspace fields are saved. Sending without these
will fail with HTTP 412 at the send call regardless, so bailing here
saves the token cost of draft generation.

Load documents via MCP:

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "business"`.
Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"`.

Pay particular attention to these sections in the sales_strategy document:
- **Outreach mode**: `precision` (deep personalization) or `volume` (template-based semi-personalization). The document always carries a concrete value — read it; do not assume a default
- **Sales channels**: tactical preferences only (channel ordering, sub-channel preferences, tone). Channel enablement (on/off) is owned by `outboundChannels` in project settings — read below, not from this section.
- **Messaging**: Subject line patterns, body structure, and A/B test instructions if any -- follow them
- **Sender information**: the name (and optional role) for the light sign-off — not a full signature block; the backend appends the compliance footer (legal name, address, unsubscribe) automatically. Sender display name and email come from project settings, **not** from this document — the backend send path uses them automatically
- **Email template**: If a template is defined, use it as a base (especially important in volume mode)
- **SNS messages**: SNS DM messaging policy

**Important:** If SALES_STRATEGY.md has specific instructions on subject line variations, A/B tests, etc., always follow them. Never ignore instructions and revert to default behavior.
**Note:** Sending timing (day of week, time of day) is not controlled by this skill.

Retrieve the uncontacted prospect list and the project's send settings:

- Call `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: $1` (default 30).
- Call `mcp__plugin_leadace_api__get_project_settings` with `projectId: "$0"`.

The targets response includes `Outbound mode: send | draft`. **Capture this value** — it determines whether each channel actually delivers (`send`) or only stores a draft for the user to review and send manually from https://app.leadace.ai/drafts (`draft`). The draft path applies to all channels (email, form, SNS).

From the settings response, surface for body composition:
- `inquiryLandingEnabled` — drives the mail template branch in step 3.
- `inquiryCtaType` (`meeting` | `signup`) — read alongside `inquiryLandingEnabled`. Determines which backup CTA the email body carries; see step 3's "Inquiry-aware CTA branch" for the rule.
- `inquiryChatBrief` (when non-empty) — the system-prompt fragment the
  recipient's inquiry chat will use. Skim it so the email body can promise
  something concrete the chat can actually deliver (e.g., if the brief
  carries pricing FAQ, the CTA can say "ask about pricing in chat"; if it
  doesn't, do not promise pricing answers).
- `inquiryOneLiner` (when non-empty) — the tagline the recipient sees on
  the landing page. Avoid contradicting it in the email subject / opener.
- `outboundMode`, `senderEmailAlias`, `senderDisplayName` — read but do
  not surface in body; the backend uses them. The `compliance` block
  (legal_name / physical_address / privacy_url) is also tenant-level and
  is appended by the backend at send time — never inline these in the body.

And surface for channel selection (apply when picking a channel in step 2):
- **`outboundChannels`** (subset of `email | form | sns_twitter | sns_linkedin`): the channels
  the project sends through. `get_outbound_targets` has already filtered the candidate list
  server-side — by enabled channel **and** by supported recipient country (unknown-country
  prospects pass through as warn-only) — so every prospect you see is reachable on an enabled
  channel and in-scope. Use `outboundChannels` only to break ties:
  when a prospect is reachable on more than one channel, rank only among the enabled ones (a
  disabled channel is never picked even if the channel policy ranks it higher). If the targets
  response came back empty with a "paused" message, outbound is off for this project — report
  it and stop.

**Gmail live pre-flight (send mode + email enabled).** If outbound mode is `send` and `email`
is in `outboundChannels`, call `mcp__plugin_leadace_api__get_gmail_status`. If it reports not
connected, warn the user that email sends will be rejected at send time (HTTP 412) and they
should connect Gmail at https://app.leadace.ai — they can still proceed with form / SNS
prospects. This is a courtesy check (status is live, never cached); the 412 at send time is the
authoritative guard, and draft mode needs no Gmail connection.

Each prospect in the targets list also carries:
- `cycle: { n, kind, lastOutreach, lastResponse }` — the prospect's
  outreach history for this project. `n` is the count of confirmed sends.
  `kind ∈ first | no_response | rejection_followup`. `lastOutreach.subject`
  is the most recent subject used; `lastResponse.responseType` is the most
  recent response (rejection / reply / etc.). When that response was a
  rejection, `lastResponse.rejectionFeedback` carries the stated objection —
  `primaryReason` (e.g. `wrong_timing` / `budget`) and `freeText` (their own
  words, may be null) — so a re-approach can answer the actual reason. Drives
  tone selection in step 3 and the re-approach branch in step 3b.
- `hasFreshSignal: boolean` — true when the org has non-empty signals
  extracted within the last 14 days. Used by the prioritisation server-side;
  you may surface it in the report.
- `recentSignals?: string[]` — up to 3 dated signal highlights from the
  server-side daily refresh (e.g. `"Raised Series B on 2026-05-20"`).
  Present only when a fresh payload carries highlights (may be absent even
  when `hasFreshSignal` is true). This is the **refreshed**
  counterpart to overview's `## Recent Signals` (a registration-time
  snapshot that never updates): when both exist, use whichever carries the
  more recent dated entries — usually `recentSignals`, except for freshly
  registered prospects. Raw material for the opening line, the bad-timing
  judgment, and re-approach hooks below.
- `hypothesis: { bestChannel, bestKeyperson }` — the build-list registrant's
  first-touch guess at the best channel (e.g. `personal_email` / `linkedin_dm`)
  and a named keyperson, when one was obvious. Either may be null. Use as
  context for channel choice and addressing — a hint, not an override: the
  `tpl_channel_policy` ranking and the country / quota gates still decide.
- `channelAffinity: [{ channel, rate, total, responses }]` — the project's
  **measured** channel ranking for this prospect's coarse industry, best first
  (e.g. `[{channel:"form",rate:14.0,total:50,responses:7},{channel:"email",rate:8.0,total:100,responses:8}]`),
  recomputed daily by the lever tick. The array order is the ranking; `rate` (%)
  / `total` / `responses` are for transparency — only the order (i.e. `channel`)
  drives selection. `[]` until that industry has enough sends per channel — most
  projects start empty. When present it reflects what has actually worked, so it
  takes precedence over the policy order (see step 2); still intersect it with
  available / enabled channels.

If the tool returns a "Project not found" error, instruct the user to run `/leadace` first and **abort**.

### 2. Approach Each Prospect

Pick **one** channel per prospect — never chain channels.

Retrieve the channel ranking policy via `mcp__plugin_leadace_api__get_master_document`
with `slug: "tpl_channel_policy"` and follow it (personal email → LinkedIn → department
email → generic email → form → X DM, with named-vs-generic address classification). It is
the **default** order. Apply it together with these project inputs, highest precedence first:

- **`outboundChannels`** (from step 1) — hard filter: rank only among the channels the
  project has enabled. The candidate list is already server-filtered to enabled channels,
  but a multi-channel prospect may still expose a disabled channel — never pick it.
- **SALES_STRATEGY's "Sales Channels"** section, when present: the user's explicit channel
  ordering. It overrides the ordering (only the ordering) and wins over the inputs below.
- **`channelAffinity`** (from step 1), when non-empty: the measured best-to-worst ranking
  for this prospect's industry. Use it as the order — it **overrides the policy default** —
  picking the top-ranked channel that is available and enabled; fall back to the policy
  order for any channels it doesn't cover. Empty (the common early state) → ignore it.
- **`tpl_channel_policy`** default order when none of the above decide.

Country eligibility is no longer a skill-side concern — `get_outbound_targets` filters to
supported recipient countries server-side (step 1).

**Attempt limit per prospect:** Limit sending attempts to **a maximum of 2** per prospect (main channel + 1 fallback only when the main channel fails for a transient reason). If both fail for any reason, immediately skip and move to the next prospect. Do not waste context and tool calls lingering on a single prospect.

**SNS DM caution:** SNS DMs have a lower reach rate (depends on recipient's DM settings). Channel enablement is handled by step 1's `outboundChannels`; do not re-check SALES_STRATEGY here.

**Bad-timing skip (optional, on by default).** Before composing, judge from
what you already have on the prospect — the `overview` (including any
`## Recent Signals`), `recentSignals`, the `hypothesis`, and the `cycle`
context — whether now is clearly a bad moment to reach this specific
recipient. What counts as "bad"
depends on the recipient; representative cases are a recent negative event that
removes or freezes the buyer (layoffs, an announced bankruptcy / wind-down, a
leadership shake-up implying the buyer left, a post-acquisition integration
freeze). Skip only when the signal is concrete and clearly negative — when in
doubt, send (a neutral read is a send, so prospects with no such signal are
unaffected).

To skip: do NOT send, and call `mcp__plugin_leadace_api__skip_prospect` with
`projectId: "$0"`, `prospectId`, the `channel` you were about to use (`email` /
`form` / `sns_linkedin` / `sns_twitter`), `reason: "bad_timing"`, and a one-line
`note` (e.g. `"layoffs announced last week"`). The server records a `skipped`
audit row and defers re-eligibility by the project's no-response recycle window
(no quota consumed); then continue to the next prospect.

If the user passed an explicit override ("send anyway", "ignore timing"),
skip the skip — they own the trade-off.

### 3. Email Sending

Retrieve email guidelines via `mcp__plugin_leadace_api__get_master_document` with `slug: "tpl_email_guidelines"` and follow them.

**Body template precedence.** If the project has an `email_template` document (`mcp__plugin_leadace_api__get_document`, `slug: "email_template"`), use it as the authoritative body template — it holds the operator's chosen voice and supersedes the "Email Template" section of SALES_STRATEGY.md. If `get_document` reports that document does not exist, fall back to that SALES_STRATEGY.md section. The shared English-standard-casual default lives in master doc `tpl_email_base`.

Close with a light sign-off (name + optional role) drawn from the "Sender Information" section of SALES_STRATEGY.md — not a full signature block; the backend appends the compliance footer (legal name, address, unsubscribe) automatically. Sender display name and `From:` address are applied automatically by `send_email_and_record` from project settings — do not pass them as arguments.

**Subject line variation (weighted draw).** Subject patterns are stored
server-side in `subject_variants`; the server picks one per send by a
weighted draw (favoring the better-performing variants, recomputed daily
by the lever tick). Per send, call
`mcp__plugin_leadace_api__pick_subject_variant` with the project id; the
response is `{ variantId, subjectPattern, label }`. Render the subject by
substituting `{{org}}` / `{{name}}` / `{{signal}}` placeholders the
pattern uses, then forward the `variantId` to `send_email_and_record` so
`outreach_logs.variant_id` is stamped for per-variant reply metrics.
The same attribution holds on any subject-bearing send: when a contact
form carries a subject variant, pass its `variantId` to
`record_outreach_with_inquiry` too (SNS DMs have no subject, so none
applies) — otherwise per-variant metrics skew toward email-only sends.

If `pick_subject_variant` returns `NOT_FOUND` ("No active subject
variants"), the project has no patterns registered yet — generate a
short one-off subject, send without `variantId`, and surface the gap in
the run-end report so the operator can add patterns via
`upsert_subject_variant` (or via `/leadace`'s strategy onboarding step). Do not
fabricate a SALES_STRATEGY.md "Subject Line Patterns" section; that
content is no longer the authoritative source.

**Signal-aware opening (Phase 1.5 hook).** If the prospect has signal
material — `recentSignals`, or a `## Recent Signals` section in `overview`
with at least one entry — the email's **first sentence** must reference the
most recent / most relevant signal in concrete terms ("Saw the Series B
announcement on TechCrunch last week — congrats on…", "Noticed you're
hiring senior platform engineers in Seattle…"). When both sources exist,
pick by entry date (both carry dates; `recentSignals` is usually fresher
since the overview section is frozen at registration). One signal mention,
then move to the actual ask. If neither source has an entry, do not invent
one; open per SALES_STRATEGY's normal pattern.

**Inquiry-aware CTA branch.** When `inquiryLandingEnabled === true`
(captured in step 1):
- The body's primary CTA should invite the recipient to spend ~5 minutes
  on the inquiry-landing page ("If a 5-minute AI conversation works
  better than scheduling a call, you can ask anything here: <inquiry URL
  is appended automatically by the backend>"). Frame it as low-effort,
  recipient-led, no calendar required. The landing page itself decides
  what the secondary CTA looks like (Book/Request a meeting vs. Sign up
  for the product) based on the project's `inquiryCtaType` — the email
  body does not need to mention either explicitly.
- Backup CTAs in the email body should match the project's CTA mode:
  when `inquiryCtaType === 'meeting'`, keep the reply / scheduling-link
  fallback; when `inquiryCtaType === 'signup'`, drop the scheduling
  fallback and lean on reply only (a "book a call" backup contradicts
  the self-serve framing the landing presents).

When `inquiryLandingEnabled === false`:
- Use the existing reply / scheduling-link / meeting-request CTA pattern
  per SALES_STRATEGY.md (the meeting-oriented fallback). Self-serve
  signup is not surfaced from the email itself in this mode — promote
  it via SALES_STRATEGY.md edits if the project's go-to-market is PLG.

In both branches the inquiry / unsubscribe URLs **and the compliance
footer** (legal name, physical address, privacy URL) are appended by
the backend — do **not** insert any of them in the body, and do **not**
include a closing address block from SALES_STRATEGY.md's "Sender
Information" beyond the human signature (name + role + sign-off).
Duplicating the address yields a confused-looking footer. If
`send_email_and_record` returns `412 Tenant compliance settings
incomplete`, surface the message verbatim and tell the user to fill in
Workspace settings at https://app.leadace.ai/workspace-settings before
retrying.

**Body personalization (vary depth by outreach mode):**

- **Precision mode**: Refer to each prospect's `overview` and `matchReason`, and write the entire body tailored to the recipient -- not just the opening. Reference specific numbers, achievements, and initiatives of the target company. Generic openers like "I visited your website" alone are insufficient
- **Volume mode**: Use the SALES_STRATEGY.md email template as a base, adjusting the opening (why you're reaching out) and the problem statement in 2 places based on `overview` / `matchReason`. The solution through CTA can follow the template structure as-is

Always call `mcp__plugin_leadace_api__send_email_and_record` regardless of mode:
- `projectId: "$0"`
- `prospectId`: the prospect's id
- `to`: array with the recipient address
- `subject`: subject line (rendered from the variant's `subjectPattern`)
- `body`: complete body including signature (no compliance footer — the
  backend appends it)
- `variantId`: from `pick_subject_variant`; omit when no variants exist

The server reads the project's `outboundMode` and decides what happens:
- `send` mode → email is sent via the user's connected Gmail. Response: `{ mode: "sent", outreachId, messageId, threadId }`.
- `draft` mode → no send; the composed email is stored as a `pending_review` draft for the user to review and send from https://app.leadace.ai/drafts. Response: `{ mode: "drafted", outreachId }`. Drafts do not count against the outreach quota.

Track the response `mode` per call for the step 8 report (sent vs. drafted counts).

On a 502 `Send failed`, the outreach is still logged with `status: "failed"` and the prospect's re-eligibility is deferred by the project's no-response recycle window — do not retry manually. On a 412 `Gmail not connected` / `Gmail token revoked`, abort all email sending for this run and surface the message; the user must reconnect Gmail in the web app's Settings.

**Notes:**
- The body must be the complete content including the signature
- The `From:` address and display name are pulled from project settings (`senderEmailAlias` / `senderDisplayName`) by the backend. If `senderEmailAlias` is set to a Send-As alias not yet verified in the user's Gmail account, sending fails with a Gmail error — surface it in the report and tell the user to verify the alias at https://mail.google.com → Settings → Accounts → "Send mail as"

### 3b. Re-approach Branching (cycle.kind != 'first')

When `cycle.kind === 'first'`, use the normal first-touch composition above.

When `cycle.kind === 'no_response'`:
- This is a follow-up after silence. Acknowledge the silence lightly
  ("circling back on my note from <approx month>"), then **lead with
  what's new** — a fresh signal from `recentSignals` or `## Recent Signals`
  (whichever is newer), a new product release, a different angle in
  `matchReason`. If you genuinely have no
  new material to add, **skip the prospect**: call
  `mcp__plugin_leadace_api__skip_prospect` with:
  - `projectId: "$0"`, `prospectId`: the prospect's id.
  - `channel`: the channel you were about to use (`email` / `form` /
    `sns_linkedin` / `sns_twitter`).
  - `reason: "no_fresh_material"`
  - `note`: e.g. `"no fresh signal since cycle n=<n>"`.

  The server records a `skipped` row and defers re-eligibility until the
  recycle window elapses. Quietly re-spamming the
  same pitch hurts the long-term reply rate.
- **Subject must differ from `cycle.lastOutreach.subject`.** Pick a
  different SALES_STRATEGY pattern. Never use a generic "Re:" or
  "Following up" alone — those are inboxes' top-of-spam triggers.

When `cycle.kind === 'rejection_followup'`:
- The recipient previously responded substantively (rejection / reply /
  bounce / meeting_request). Auto-replies do NOT set this kind — they
  fall under `no_response`, so a `rejection_followup` always has a real
  prior reason to reference.
- Inspect `cycle.lastResponse`:
  - `responseType: 'rejection'` (or negative `'reply'`): the recipient
    previously declined and the recontact window has now elapsed. Use
    `lastResponse.rejectionFeedback.primaryReason` (and `freeText` if
    present) to open against the actual objection — reference it, don't
    quote verbatim — then lead with what's specifically changed since
    (`recentSignals`, Phase 1.5 signals, product updates, pricing changes).
  - `'meeting_request'` / positive `'reply'`: unusual to be back in
    the candidate pool — only happens if the recycle window elapsed
    without a follow-up booking. Reference the earlier interest neutrally.
- If no concrete change has happened, skip — same logic as `no_response`
  (the server stamps the recycle window so future runs drop the prospect
  until the window elapses).
- Tone is collegial, not pitchy. They opted in to "later" or never
  responded substantively; do not punish that with hard sell.

### 4. Contact Form Submission

Read `${CLAUDE_PLUGIN_ROOT}/skills/outbound/references/claude-in-chrome-guide.md` and `${CLAUDE_PLUGIN_ROOT}/skills/outbound/references/form-filling.md` for the underlying procedures.

Compose the message body per the form's fields and the email guidelines (adapted to be concise).

**Allocate the row + inquiry URL.** Before opening the browser or doing any form inspection, call:

```
mcp__plugin_leadace_api__record_outreach_with_inquiry
  projectId: "$0"
  prospectId: <id>
  channel: "form"
  body: <composed body>
```

The server reads the project's `outboundMode` and either allocates the row as `status: "pre_send"` (send mode, in-flight reservation) or `status: "pending_review"` (draft mode). When `inquiryLandingEnabled=true` the response's `finalBody` carries the inquiry-landing URL footer appended to the body — submit it verbatim. The response is `{ outreachLogId, status, finalBody, inquiryUrl }`.

**If `status === 'pending_review'` (draft mode):** stop here. The row is already stored for the user to review at https://app.leadace.ai/drafts. Do not open the browser, do not inspect the form, do not check `formType`. The user submits whatever form themselves; pre-screening (CAPTCHA / iframe / sales refusal notices) is irrelevant in draft mode.

**If `status === 'pre_send'` (send mode):** open the form page and run pre-submit screening before any form-fill. Branch on `formType`:

| formType | Processing |
|---|---|
| `google_forms` | Follow "Google Forms" section in `references/form-filling.md`. Extract entry IDs via `javascript_tool`, then submit via `formResponse` POST with curl |
| `native_html` / `wordpress_cf7` / null | Use claude-in-chrome MCP tools (`navigate`, `read_page` / `find`, `form_input`, `computer`, `read_network_requests`). Follow basic flow in `references/form-filling.md` |
| `iframe_embed` | Skip. Call `update_outreach_status` with `status: "failed"`, `errorMessage: "iframe-embedded form -- skipped"` |
| `with_captcha` | Skip. Call `update_outreach_status` with `status: "failed"`, `errorMessage: "captcha present"`. Follow "reCAPTCHA / hCaptcha etc." section in `references/form-filling.md` for the prospect-status handling |

Other pre-submit skip cases — **sales refusal notice** ("no sales inquiries", "営業お断り" etc.) or **no form on the page** — likewise resolve the `pre_send` row with `update_outreach_status`, `status: "failed"`, and a concise `errorMessage`. Then continue with the case-specific prospect status update per `references/form-filling.md` (e.g. sales refusal → set prospect `inactive`).

If `formType` is null (not yet determined), inspect the page with `read_page` / `find` first. **However, if null, skip immediately on first attempt failure** (to prevent wasted tool calls in case it's iframe_embed or with_captcha) — call `update_outreach_status` with `status: "failed"` and `errorMessage: "form not parseable"`.

**Filling the form.** Once screening passes, fill the form fields using `finalBody` as the message text (the inquiry URL is already in `finalBody` — submit it verbatim, do not strip or re-embed it), then submit per `references/form-filling.md`.

**After submission verification.** Always call `mcp__plugin_leadace_api__update_outreach_status`:
- On success → `status: "sent"`. The server flips the prospect to `contacted` and confirms quota consumption.
- On failure (HTTP 4xx/5xx, no POST observed, no thank-you state, etc.) → `status: "failed"` plus a concise `errorMessage`. The in-flight quota reservation is refunded and the server defers re-eligibility by the project's no-response recycle window. Do not retry the form.

### 5. SNS DM

**Message:** Keep it short and concise for SNS. Refer to the "SNS Messages" section of SALES_STRATEGY.md.

Determine the channel from the prospect's `snsAccounts` field — use `sns_twitter` for X / Twitter and `sns_linkedin` for LinkedIn. Compose the DM body per SALES_STRATEGY.md guidance.

**Allocate the row + inquiry URL.** Before opening the browser (in send mode) or anything else, call:

```
mcp__plugin_leadace_api__record_outreach_with_inquiry
  projectId: "$0"
  prospectId: <id>
  channel: "sns_twitter" | "sns_linkedin"
  body: <composed DM body>
```

The server returns `{ outreachLogId, status, finalBody, inquiryUrl }`. `finalBody` already includes the inquiry-landing URL footer when the project has it enabled — submit it verbatim.

**If `status === 'pending_review'` (draft mode):** stop here. The DM is stored as a draft (with `finalBody`) for the user to send manually from https://app.leadace.ai/drafts. Do not open the browser or pre-check DM settings — the user finds out at send time and can mark the prospect inactive then.

**If `status === 'pre_send'` (send mode):** use claude-in-chrome to deliver the DM. See `references/claude-in-chrome-guide.md` for tool reference.

**Common steps:**
1. Navigate to the SNS profile page in the browser.
2. Open the DM / messaging UI.
3. Type `finalBody` and send.

**For X (Twitter):**
- Click the DM (message) icon from the profile page.
- If recipient's DM settings are closed, sending is not possible — call `update_outreach_status` with `outreachLogId`, `status: "failed"` and `errorMessage: "X DM closed"`, then call `update_prospect_status` with `status: "inactive"`.

**For LinkedIn:**
- Click the "Message" button from the profile page.
- DMs can only be sent to connected users. If not connected, call `update_outreach_status` with `status: "failed"` and `errorMessage: "LinkedIn not connected"`, then set the prospect to `inactive`.
- Do not use InMail (paid feature).

**After sending:** the row is `pre_send` until you resolve it. Always call `update_outreach_status`:
- On success → `status: "sent"`.
- On failure (UI error, network failure, etc.) → `status: "failed"` plus a concise `errorMessage`.

### 6. Handle Inactive Prospects

For prospects where approach failed due to a **structural reason** making future approaches impossible, call `mcp__plugin_leadace_api__update_prospect_status` with `status: "inactive"`.

**Cases where `inactive` should be set:**
- Email address was invalid and bounced (permanent error)
- SNS DMs are not open
- Form was not suitable for B2B inquiries
- No available contact method at all

**Cases where `inactive` should NOT be set (keep as `new`):**
- Temporary network error or timeout
- System-side issues such as Gmail token revocation or quota exhaustion

### 7. Additional Outreach When Target Not Met

After all prospects are processed, if successes fall short of the target count:

1. Shortfall = target count - successes (in draft mode, count `pending_review` records as success — drafts are the intended outcome)
2. Retrieve additional prospects: call `mcp__plugin_leadace_api__get_outbound_targets` with `limit: <shortfall>`
3. Repeat steps 2-6 for retrieved prospects
4. Retry **one round only**. Also end retry if total reachable is 0
5. Include final target achievement in the report (e.g., "Target 5, achieved 3 (ended due to depleted list)")

### 8. Results Report

Report the following:
- Number of prospects approached
- Attempts and successes per channel, success rate (Email: X successes/Y attempts (XX%), Form: X successes/Y attempts (XX%), SNS: X successes/Y attempts (XX%))
- If `outboundMode` was `draft`, report total drafts created across all channels (Drafts: N) and remind the user to review and send them at https://app.leadace.ai/drafts
- **Missing-tool warnings**: if any send failed because a tool was not connected (Gmail not connected → email; Claude in Chrome unavailable → form / SNS), list it and recommend connecting the tool before the next run. Especially relevant in draft mode, where these tools weren't exercised but will be needed when the user sends the drafts.
- Number of failures and reasons
- Guide the user to run `/check-responses` as the next step (or, if drafts were created, after the user sends the reviewed drafts)
- Append a single low-key dashboard line at the end: `Dashboard: https://app.leadace.ai/outreach` — purely informational, do not push the user to open it
