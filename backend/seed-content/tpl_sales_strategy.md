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
(Industry/domain, size, role, characteristics)
### Secondary Target

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

## Sender Information
- Signature: (A light sign-off appended to emails — e.g., `Best,` + your full name, optionally your role. Keep it light; avoid phone / postal address / multiple URLs. The backend appends the email footer automatically (by default: legal name + physical address + opt-out).)
- Scheduling link: (Timerex / Calendly / Cal.com URL. In meeting CTA mode, the inquiry-landing page uses this URL behind its "Book a meeting" button. If inquiry landing is disabled, this URL is also embedded inline in email CTAs as the meeting fallback.)
- Signup URL: (SaaS self-serve signup / "Get started" / "Start your trial" URL. In signup CTA mode, the inquiry-landing page uses this URL behind its "Sign up" button. **Never embedded in email bodies** — the recipient reaches the signup page through the inquiry-landing footer link. Mutually exclusive with the scheduling link — the project picks one CTA mode.)

## Messaging
### First Outreach (Email/Form)
(What to emphasize and what never to claim on first contact — the angle, the proof worth citing, wording the business must avoid. Body shape, length and CTA form come from the `tpl_email_guidelines` master document, and subject patterns plus per-angle body briefs live server-side in `message_variants` — do not restate either here.)
### Inquiry Landing CTA Mode

The project picks one CTA mode for the inquiry-landing page (`/q/<short_id>`):

- **meeting** (default): the landing page renders a "Book a meeting" / "Request a meeting" button. The recipient who arrives at the landing page can request a meeting in-place; backend records it as a `lead` outcome
- **signup** (SaaS self-serve): the landing page renders a "Sign up" button linking to the project's signup URL. The recipient who arrives at the landing page can self-serve via the signup URL; backend records it as a `signup_clicked` outcome

The two modes are mutually exclusive per project — the inquiry-settings page enforces a single CTA URL. The CTA mode shapes the landing-page button only; outbound email bodies link only to the inquiry-landing page (backend-appended footer) and never to the scheduling or signup URL directly. Email CTA framing details are in the `tpl_email_guidelines` master document.
### SNS Messages
(Short and concise. Self-introduction → value proposition → action.)
- **Prerequisite:** If using SNS DMs, log into each enabled SNS account in Chrome beforehand

## Response Definition
- What counts as a response: (Direct email reply, scheduling completion notification, reply via contact form, etc.)
- Scheduling service in use: (Service name and notification sender email. Example: Timerex — notifications@timerex.net)
- Other response signals: (Notifications from specific services, etc. List if applicable.)

## Notification Settings
- daily-cycle completion notification recipient: (Email address to receive completion reports. "None" if not needed.)

## KPI
(Metrics to track: number of sends, open rate, response rate, meeting conversion rate, etc.)

## Search Keywords
(Keyword list for finding prospects. Industry names, service categories, related terms, etc.)
```

(Environment / tool status is live-detected at run time, never stored in a project document. The outbound channel allowlist is Project Settings → `outboundChannels`.)

**Generation guidelines:**
- **Target length ~180 lines or fewer.** This is a strategy design doc — do not pad sections. Never add a runtime-actuals / KPI-history table: send / draft / response counts live in structured storage and are surfaced in the Web UI. The `## KPI` section carries *target* metrics + the reverse-calc tree only, never actuals.
- Keep the elevator pitch specific and concise. Avoid jargon; make it easy to understand
- Make targets as specific as possible (not "small businesses" but "SaaS companies with 50-200 employees in the US"; not "retailers" but "DTC e-commerce brands with under 50 employees")
- Structure messaging to lead with recipient benefits
- List at least 10 search keywords
- Discovery strategies are NOT a section of this document — they live in the project's strategy registry (`upsert_discovery_strategy` / `get_lever_state`), where /build-list executes them and /evaluate attributes reply rates per slug.
- **Sales Channels section rules:**
  - Channel on/off (`email` / `form` / `sns_twitter` / `sns_linkedin`) is owned by Project Settings (`outboundChannels`) and read by `/outbound` and `/build-list`. **Never restate enablement / disablement here.**
  - This section may carry tactical preferences Project Settings can't express: channel ordering ("SNS DM before email for consumer-facing prospects"), tone, sub-channel preferences ("prefer named-personal emails over generic"). `/outbound` reads the order from here when present.
  - **Do not** write sub-channel exclusions like "info@-style addresses: not contacted". The channel policy (master document `tpl_channel_policy`, applied by `/outbound`) collects every reachable email and demotes generic addresses rather than excluding them. A *preference* ("prefer named over generic") is fine; an *exclusion* breaks that collection behavior.
- **SNS Messages section rules:**
  - Which SNS platforms are enabled (`sns_twitter` / `sns_linkedin`) is owned by Project Settings `outboundChannels`. **Do not restate enablement here** (no "SNS used: X / LinkedIn / Both" line). The section is for DM message style / tone only.
