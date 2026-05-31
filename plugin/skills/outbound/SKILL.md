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
  - mcp__plugin_leadace_api__record_outreach
  - mcp__plugin_leadace_api__record_outreach_with_inquiry
  - mcp__plugin_leadace_api__update_outreach_status
  - mcp__plugin_leadace_api__update_prospect_status
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__get_master_document
  - mcp__plugin_leadace_api__get_project_settings
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
Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "env_status"`. Source of truth for connected tools (Gmail SaaS / Claude in Chrome), saved by `/leadace`. Hold the result as `ENV` (or `null` if the document doesn't exist). The send-mode capability gate below decides whether to abort — a missing doc is fatal in send mode (run `/leadace` first) but tolerated in draft mode (no tools are invoked; surface the gap in the step 8 report).

Pay particular attention to these sections in the sales_strategy document:
- **Outreach mode**: `precision` (deep personalization) or `volume` (template-based semi-personalization). Default to `precision` if not set
- **Sales channels**: tactical preferences only (channel ordering, sub-channel preferences, tone). Channel enablement (on/off) is owned by `outboundChannels` in project settings — read below, not from this section.
- **Messaging**: Subject line patterns, body structure, and A/B test instructions if any -- follow them
- **Sender information**: Signature block (organization phone, name, title, etc.). Sender display name and email come from project settings, **not** from this document — the backend send path uses them automatically
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

And surface for prospect gating (apply before picking a channel in step 2):
- **`outboundChannels`** (subset of `email | form | sns_twitter | sns_linkedin`): the channels
  the project is allowed to use. Treat any channel outside this set as **disabled** — when
  ranking against the default ladder (or SALES_STRATEGY's "Sales Channels"), simply skip
  disabled channels. If a prospect's only reachable channel is disabled, skip the prospect
  entirely (no `record_outreach` audit row needed — it is a project-policy decision, not a
  per-prospect compliance refusal). If `outboundChannels` is empty, **abort the entire
  /outbound run** and tell the user that outbound is paused for this project.
- **env_status capability** — pre-flight gate, **send mode only**. In send mode, every channel in `outboundChannels` requires its tool to be connected: `email` requires Gmail SaaS; `form` / `sns_twitter` / `sns_linkedin` require Claude in Chrome. Treat a capability whose recorded value is `unsure`, absent from `ENV`, or where `ENV` itself is `null` (env_status doc missing) as unavailable (conservative). If **any** channel in `outboundChannels` is unavailable, **abort the entire run** before processing prospects and tell the user to either connect the missing tool (run `/leadace` after reconnecting if env_status was missing entirely) or remove that channel from Project Settings → `outboundChannels`, then re-run. Do **not** silently skip per-prospect: `get_outbound_targets` only knows `outboundChannels` server-side, so a skill-side filter is lossy — the backend keeps returning candidates the skill would skip, and form / SNS prospects never surface within the run's `limit`. Draft mode bypasses this entirely (server-side `pending_review`, no Gmail / browser call); surface any missing tool (or missing env_status) in the step 8 report.
- **`targetCountries`** (subset of `US | CA | JP`): when non-empty, treat any prospect whose
  resolved `country` (prospect.country, then organization.country) falls outside the set as
  out-of-scope and skip without recording — this is a project-policy decision, not a
  compliance refusal. The send-time compliance gate still enforces the unchanged US / CA / JP
  rule for any country = null prospects that slip through. When `targetCountries` is empty
  (default), retain the existing US / CA / JP behavior described in the "Country pre-flight"
  block below.

Each prospect in the targets list also carries:
- `cycle: { n, kind, lastOutreach, lastResponse }` — the prospect's
  outreach history for this project. `n` is the count of confirmed sends.
  `kind ∈ first | no_response | rejection_followup`. `lastOutreach.subject`
  is the most recent subject used; `lastResponse.responseType` is the most
  recent response (rejection / reply / etc.). Drives tone selection in step 3
  and the re-approach branch in step 3b.
- `hasFreshSignal: boolean` — true when `org_signals_global.signals_updated_at`
  is within the last 14 days. Used by the prioritisation server-side; you
  may surface it in the report.

If the tool returns a "Project not found" error, instruct the user to run `/leadace` first and **abort**.

### 2. Approach Each Prospect

Pick **one** channel per prospect. SALES_STRATEGY's "Sales Channels"
section, when present, defines **ordering preferences only** — apply
its order **among the channels enabled** by step 1's `outboundChannels`
gate. (In send mode, step 1's env_status pre-flight has already aborted
the run if any enabled channel's tool is missing; if execution reaches
here, every channel in `outboundChannels` is usable.) Skip any channel
its order references that is disabled; never treat that section as
overriding the gate. The ladder below is the **default** used when
SALES_STRATEGY omits "Sales Channels" or doesn't constrain ordering.

**Default channel ladder (apply when SALES_STRATEGY does not override):**

1. **Personal email** — `email` is set AND looks like a named address
   (`first.last@`, `flast@`, `f.last@`, etc., not a department mailbox).
2. **LinkedIn DM** — `snsAccounts.linkedin` is set. Skip this rung if the
   prospect is not a 1st-degree connection (the browser flow surfaces this).
3. **Department email** — `email` is set and starts with a department
   prefix like `sales@`, `bd@`, `partnerships@`, `recruiting@`.
4. **Generic email** — `email` is set and starts with `info@`, `contact@`,
   `support@`, `hello@`, `pr@`. Demoted but **never excluded** — for many
   small companies it is the only reachable address. The mid-funnel reply
   rate is lower; reflect that in priority, not in eligibility.
5. **Contact form** — `contactFormUrl` is set.
6. **X / Twitter DM** — `snsAccounts.x` is set. Lowest rung because reach
   depends on the recipient's DM-settings.

If a step is the only one that produces a valid channel for the prospect,
use it. Channels disabled by `outboundChannels` are already filtered in
step 1's gating block — do not re-derive enablement from SALES_STRATEGY
here. (In send mode, step 1 also verified each enabled channel's tool is
connected; the run aborted upfront if any was missing, so by this point
every enabled channel is usable.) One channel per prospect — do not chain
channels.

**Country pre-flight.** Each prospect carries `country` (and the
organization carries one as fallback). LeadAce currently only allows sends
to recipients in `US`, `CA`, and `JP` — anywhere else is blocked at send
time with HTTP 422. Skip non-allowed prospects up front so the report
stays clean:

1. Treat `country ∈ {null, undefined, 'US', 'CA', 'JP'}` as eligible. `null`
   is warn-only at send time; we proceed but the operator should backfill.
2. For any other country code, do NOT call the send tool. Instead call
   `mcp__plugin_leadace_api__record_outreach` with:
   - `channel`: the first reachable channel for this prospect from the
     default ladder above (`email` if `email` is set, else `form` if
     `contactFormUrl` is set, else `sns_linkedin` / `sns_twitter`).
     The row is audit-only; channel just records *which* path would
     have been tried.
   - `body`: a one-line audit string, e.g. `"skipped: country not
     supported (<code>)"`. Body is required by the schema but never
     reaches the recipient on a `failed` row.
   - `status: "failed"`
   - `errorMessage: "skipped: country not supported (<code>) — currently
     sends to US/CA/JP only"`

   The server stamps `next_outreach_after` so the prospect drops out of
   `get_outbound_targets` for the recycle window; quota is not consumed.

**Attempt limit per prospect:** Limit sending attempts to **a maximum of 2** per prospect (main channel + 1 fallback only when the main channel fails for a transient reason). If both fail for any reason, immediately skip and move to the next prospect. Do not waste context and tool calls lingering on a single prospect.

**SNS DM caution:** SNS DMs have a lower reach rate (depends on recipient's DM settings). Enablement is handled by step 1's `outboundChannels` gate (plus the send-mode env_status gate); do not re-check SALES_STRATEGY here.

**Bad-timing skip (optional, on by default).** If the prospect's `overview`
contains a `## Timing` section that explicitly says now is a bad moment
(layoffs ongoing, just announced bankruptcy / wind-down, recent leadership
shake-up implying the buyer left, post-acquisition integration freeze),
skip outreach entirely:

1. Do NOT send.
2. Call `mcp__plugin_leadace_api__record_outreach` with:
   - `channel`: the channel you were about to use (or the first reachable
     channel if you hadn't picked one yet — `email` / `form` /
     `sns_linkedin` / `sns_twitter`).
   - `body`: a one-line audit string, e.g. `"skipped: bad timing —
     <one-line reason>"`. Body is required by the schema but never
     reaches the recipient on a `failed` row.
   - `status: "failed"`
   - `errorMessage: "skipped: bad timing — <one-line reason>"`

   The server stamps the prospect's `next_outreach_after` to
   `now + noResponseRecycleDays` (default 90 days), so they drop out of
   `get_outbound_targets` until that window elapses. No quota is consumed.
3. Continue to the next prospect.

If the user passed an explicit override ("send anyway", "ignore timing"),
skip the skip — they own the trade-off.

### 3. Email Sending

Retrieve email guidelines via `mcp__plugin_leadace_api__get_master_document` with `slug: "tpl_email_guidelines"` and follow them. Get the signature block from the "Sender Information" section of SALES_STRATEGY.md (append it to the body). Sender display name and `From:` address are applied automatically by `send_email_and_record` from project settings — do not pass them as arguments.

**Subject line variation (round-robin).** Subject patterns are stored
server-side in `subject_variants` and rotated by the server. Per send,
call `mcp__plugin_leadace_api__pick_subject_variant` with the project
id; the response is `{ variantId, subjectPattern, label }` and the
server's cursor advances by one. Render the subject by substituting
`{{org}}` / `{{name}}` / `{{signal}}` placeholders the pattern uses,
then forward the `variantId` to `send_email_and_record` so
`outreach_logs.variant_id` is stamped (this is what `/evaluate` joins
to compare reply rates).

If `pick_subject_variant` returns `NOT_FOUND` ("No active subject
variants"), the project has no patterns registered yet — generate a
short one-off subject, send without `variantId`, and surface the gap in
the run-end report so the operator can add patterns via
`upsert_subject_variant` (or via `/leadace`'s strategy onboarding step). Do not
fabricate a SALES_STRATEGY.md "Subject Line Patterns" section; that
content is no longer the authoritative source.

**Signal-aware opening (Phase 1.5 hook).** If the prospect's `overview`
contains a `## Recent Signals` section with at least one entry, the email's
**first sentence** must reference the most recent / most relevant signal
in concrete terms ("Saw the Series B announcement on TechCrunch last
week — congrats on…", "Noticed you're hiring senior platform engineers in
Seattle…"). One signal mention, then move to the actual ask. If
`## Recent Signals` is absent or empty, do not invent one; open per
SALES_STRATEGY's normal pattern.

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

On a 502 `Send failed`, the outreach is still logged with `status: "failed"` and the prospect's `next_outreach_after` is stamped to defer re-eligibility by `noResponseRecycleDays` (default 90 days) — do not retry `record_outreach` manually. On a 412 `Gmail not connected` / `Gmail token revoked`, abort all email sending for this run and surface the message; the user must reconnect Gmail in the web app's Settings.

**Notes:**
- The body must be the complete content including the signature
- The `From:` address and display name are pulled from project settings (`senderEmailAlias` / `senderDisplayName`) by the backend. If `senderEmailAlias` is set to a Send-As alias not yet verified in the user's Gmail account, sending fails with a Gmail error — surface it in the report and tell the user to verify the alias at https://mail.google.com → Settings → Accounts → "Send mail as"

### 3b. Re-approach Branching (cycle.kind != 'first')

When `cycle.kind === 'first'`, use the normal first-touch composition above.

When `cycle.kind === 'no_response'`:
- This is a follow-up after silence. Acknowledge the silence lightly
  ("circling back on my note from <approx month>"), then **lead with
  what's new** — a fresh signal from `## Recent Signals`, a new product
  release, a different angle in `matchReason`. If you genuinely have no
  new material to add, **skip the prospect**: log via `record_outreach`
  with:
  - `channel`: the channel you were about to use (`email` / `form` /
    `sns_linkedin` / `sns_twitter`).
  - `body`: a one-line audit string, e.g. `"skipped: no fresh material
    for re-approach (cycle n=<n>)"`. Body is required by the schema
    but never reaches the recipient on a `failed` row.
  - `status: "failed"`
  - `errorMessage: "skipped: no fresh material for re-approach (cycle
    n=<n>)"`

  The server stamps `next_outreach_after` so the prospect drops out of
  future runs until the recycle window elapses. Quietly re-spamming the
  same pitch hurts the long-term reply rate.
- **Subject must differ from `cycle.lastOutreach.subject`.** Pick a
  different SALES_STRATEGY pattern. Never use a generic "Re:" or
  "Following up" alone — those are inboxes' top-of-spam triggers.

When `cycle.kind === 'rejection_followup'`:
- The recipient previously responded substantively (rejection / reply /
  bounce / meeting_request). Auto-replies do NOT set this kind — they
  fall under `no_response`, so a `rejection_followup` always has a real
  prior reason to reference.
- Inspect `cycle.lastResponse.responseType`:
  - `'rejection'` (or `'reply'` with negative sentiment, surfaced as
    `'reply'` here): recipient previously rejected with a recontact
    window now elapsed (`wrong_timing` / `budget`). Open by referencing
    the prior reason without quoting it verbatim ("When I reached out
    in Q1 you mentioned timing wasn't right — checking back now…"),
    then highlight what's specifically changed since (Phase 1.5
    signals, product updates, pricing changes).
  - `'meeting_request'` / `'reply'` (positive): unusual to be back in
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
- On failure (HTTP 4xx/5xx, no POST observed, no thank-you state, etc.) → `status: "failed"` plus a concise `errorMessage`. The in-flight quota reservation is refunded and the server stamps `next_outreach_after` to defer re-eligibility by `noResponseRecycleDays` (default 90 days). Do not retry the form.

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
- **Missing-tool warnings (from env_status)**: list any tool whose capability is not-connected / unsure (Gmail SaaS → blocks email auto-send; Claude in Chrome → blocks form / SNS auto-send) and recommend reconnecting + re-running `/leadace`. Especially important in draft mode, where these tools were bypassed but will be needed when the user sends the drafts.
- Number of failures and reasons
- Guide the user to run `/check-results` as the next step (or, if drafts were created, after the user sends the reviewed drafts)
- Append a single low-key dashboard line at the end: `Dashboard: https://app.leadace.ai/outreach` — purely informational, do not push the user to open it
