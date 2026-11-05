# SALES_STRATEGY.md Template

Generate the `SALES_STRATEGY.md` document with the following structure:

```markdown
# Sales & Marketing Strategy

## Elevator Pitch
(A one-liner that can be delivered in 30 seconds)

## Problems Solved
(The challenges your target faces and how you solve them)

## Target
### Primary Target
(The need they state themselves and the kind of page that states it; industry/domain, size, role)
### Secondary Target
### Prerequisites
(What must already be true for them to use and buy this, and where a page states it)
### Not a fit
(Who looks like a target but cannot use it, has no reason to buy, or is so large that a published address reaches no one who decides)

## Value Proposition
(Why customers should choose you)

## Track Record / Social Proof
(Specific track records, numbers, and case studies that can be referenced in emails. Prepare at least one.)

Examples:
- Adoption: "Deployed at XX companies", "Currently piloting at X companies in beta"
- Outcome numbers: "Generate XX leads per month", "Reduced sales workload by XX hours/week", "Reduced cost by XX%"
- Customer testimonials: "XX was improved" (with permission)
- Own track record: "Used in our own sales process, resulting in XX meetings booked"
- Awards/media: "Winner of XX Award", "Featured in XX"

Note: Even at an early stage with no case studies yet, include estimated effects based on self-usage track records or feature capabilities

## Sales Channels
(Channel ordering, tone, sub-channel preferences. Optional.)

## Messaging
### First Outreach (Email/Form)
(What to emphasize and what never to claim on first contact — the angle, the proof worth citing, wording the business must avoid. Body shape, length and CTA form come from the `tpl_email_guidelines` master document, and subject patterns plus per-angle body briefs live server-side in `message_variants` — do not restate either here.)
### SNS Messages
(Short and concise. Self-introduction → value proposition → action.)
- **Prerequisite:** If using SNS DMs, log into each enabled SNS account in Chrome beforehand

## Response Definition
- What counts as a response: (Direct email reply, scheduling completion notification, reply via contact form, etc.)
- Scheduling service in use: (Service name and notification sender email. Example: Timerex — notifications@timerex.net)
- Other response signals: (Notifications from specific services, etc. List if applicable.)

## KPI
(Metrics to track: number of sends, open rate, response rate, meeting conversion rate, etc.)

## Search Keywords
(Keyword list for finding prospects. Industry names, service categories, related terms, etc.)
```

(Environment / tool status is live-detected at run time, never stored in a project document. The outbound channel allowlist is Project Settings → `outboundChannels`.)

**Generation guidelines:**
- **Target length ~180 lines or fewer.** This is a strategy design doc — do not pad sections. Never add a runtime-actuals / KPI-history table: send / draft / response counts live in structured storage and are surfaced in the Web UI. The `## KPI` section carries *target* metrics + the reverse-calc tree only, never actuals.
- Keep the elevator pitch specific and concise. Avoid jargon; make it easy to understand
- Target is the premise everything else rests on: organizations that have stated, on a page of their own in the last 12 months, a need this product meets — which need, and the kind of page (a job post, a call or tender and its result, a plan or report, a post). The Target itself says which page counts: the page stating the need — never one that only shows what the organization is or already does (a notice of its own exam or event, a program it runs), nor a list of organizations. An open tender is answered by bidding, not by email. Be specific ("US SaaS companies with 50-200 employees hiring their first SDR", not "small businesses"). `Prerequisites` names what a page states of the company itself — "publishes X", not "mentions X". `Not a fit` outranks `Prerequisites`: a company that matches it is skipped however well it qualifies — `/build-list` drops them, `/evaluate` re-examines this section first
- Messaging emphasizes the need the recipient stated (what and when), how the product meets it, and where it may not fit
- List at least 10 search keywords
- Discovery strategies are NOT a section of this document — they live in the project's strategy registry (`upsert_discovery_strategy` / `get_lever_state`), where /build-list executes them and /evaluate attributes reply rates per slug.
- **Sales Channels section rules:**
  - Channel on/off (`email` / `form` / `sns_twitter` / `sns_linkedin`) is owned by Project Settings (`outboundChannels`) and read by `/outbound` and `/build-list`. **Never restate enablement / disablement here.**
  - This section may carry tactical preferences Project Settings can't express: channel ordering ("SNS DM before email for consumer-facing prospects"), tone, sub-channel preferences ("prefer named-personal emails over generic"). `/outbound` reads the order from here when present.
  - **Do not** write sub-channel exclusions like "info@-style addresses: not contacted". The channel policy (master document `tpl_channel_policy`, applied by `/outbound`) collects every reachable email and demotes generic addresses rather than excluding them. A *preference* ("prefer named over generic") is fine; an *exclusion* breaks that collection behavior.
- **SNS Messages section rules:**
  - Which SNS platforms are enabled (`sns_twitter` / `sns_linkedin`) is owned by Project Settings `outboundChannels`. **Do not restate enablement here** (no "SNS used: X / LinkedIn / Both" line). The section is for DM message style / tone only.
