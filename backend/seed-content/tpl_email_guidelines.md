# Email Writing Guidelines

## Core Policy

Write emails tailored to each prospect based on the "Messaging" section and "Outreach Mode" in SALES_STRATEGY.md.

## Policy by Outreach Mode

Check the "Outreach Mode" in SALES_STRATEGY.md and vary the depth of personalization accordingly.

### precision mode (default)

Maximize response rate with deep personalization.

- **Information gathering**: In addition to the prospect's `overview` and `match_reason`, reference recent news, press releases, job postings, funding rounds, and other current information
- **Opening**: Reference specific initiatives, figures, or achievements of the recipient ("e.g., joint job fair with 700 companies")
- **Problem framing → solution**: Build around the prospect's specific situation. Generic industry challenges alone are insufficient
- **Overall body**: Weave specific information drawn from overview / match_reason throughout multiple sections

### volume mode

Prioritize efficiency with template-based semi-personalization.

- **Information gathering**: Use only `overview` and `match_reason`. No additional research needed
- **Opening**: Reference the recipient's company name, industry, and main service (one line is sufficient)
- **Problem framing → solution**: Use the project's `email_template` document structure as-is. Adjust only to swap in industry-relevant challenges
- **Overall body**: Maintain the template skeleton while varying the opening and problem framing per prospect

## Deliverability: avoid content fingerprints

Repeated, near-identical bodies are a concrete spam-deliverability failure, not just a "feels templated" problem. Gmail clusters messages by content similarity: once a recurring body / structure / boilerplate accumulates spam reports anywhere, Gmail flags *similar* future messages as "similar to mail previously identified as spam" — even from a brand-new sending domain and even to a first-time recipient. Repeated identical content at volume is exactly what that classifier feeds on, and it is sender-independent (switching the From address does not reset it).

Treat near-duplicate cold sends as a deliverability risk to actively minimize:

- **Every cold send should be genuinely distinct.** Vary the opener, sentence structure, paragraph order, problem framing, and CTA phrasing across prospects. Two emails to two different prospects must not be near-duplicates.
- **Never ship the same non-personalized sentences verbatim across a batch.** Boilerplate that is byte-identical send-to-send is the fingerprint.
- **volume mode caveat**: the `email_template` skeleton is a *starting structure to reword*, not text to send as-is. Re-express the connective and solution sentences each time; do not keep an identical block across the batch just because it is not the personalized part.
- **Fewer, more distinct, well-targeted sends beat high-volume near-duplicates** — for response rate and to avoid burning the sending domain. When in doubt, prefer precision mode (see SALES_STRATEGY.md "Outreach Mode").

## Subject Line

- **40–60 characters (6–8 words)** is optimal. Keep it scannable on mobile
- Convey recipient benefits or challenges
- Avoid generic subjects like "Proposal", "Announcement", "Notice"
- Vary the subject for each prospect. Never use the same subject for all outreach
- **If SALES_STRATEGY.md defines subject line patterns or A/B test instructions, always follow them**
- Examples: "Your school's career support × AI interviews", "Case study: 30% reduction in hiring costs"

## Body Structure

1. **Opening greeting** (1-2 lines): Use "{full name}" if the prospect's `contact_name` is in the DB, otherwise use "{organization name} Team" — using "Team" alone reads as mass outreach and is prohibited. Briefly explain why you're reaching out
2. **Problem framing** (2-3 lines): Specifically address the challenge the recipient likely faces
3. **Solution** (2-3 lines): How your service solves it
4. **Proof (optional, 1 line)**: If you have a concrete, relevant proof point — a number or a comparable customer from the "Track Record / Social Proof" section of SALES_STRATEGY.md — include one short line; specifics build credibility. If none fits naturally, skip it. A short honest ask beats forced credentials
5. **CTA** (1 line): Present exactly one next action
6. **Legal required disclosures**: Opt-out notice (see below)
7. **Sign-off** (1-2 lines): Close light, in the email's language — a short sign-off (`Best,` for English; a natural Japanese close such as `よろしくお願いいたします` for Japanese) on one line, your name on the next; add your role only if it helps. Do **not** paste a full signature block (phone, postal address, multiple URLs): cold email closes light, and the backend appends the compliance footer (legal name, physical address, unsubscribe) automatically. Take the name/role from the "Sender Information" section of SALES_STRATEGY.md

## CTA (Call to Action)

**One CTA per email.** Multiple asks ("please also check our materials", "we'd love a reply", "please visit our site") lower response rates.

**Question format is most effective:**
- Good: "Could we schedule 15 minutes for an information exchange next week?"
- Good: "Do you face the same challenge at your company?"
- Bad: "See details here" (looks like no reply needed)
- Bad: "Please contact us" (action is vague)

**When a scheduling link is available (meeting CTA mode):**
- Add the link after the CTA question: "Could we find time? Please pick a time that works for you: {link}"
- Don't just paste the link and stop. Use a question to encourage a reply

**Signup CTA mode (inquiry-landing page renders the Sign up button):**

When the project's `inquiryCtaType` is `signup`, the recipient reaches the self-serve signup path through the **inquiry-landing page**, not directly from the email body. The landing URL is appended automatically as the email footer; the landing page itself renders a "Sign up" button linking to the project's `inquirySignupUrl`. The signup URL itself **must never** appear in the email body — pasting it inline bypasses the landing page, so `signup_clicked` is never recorded and the prospect remains re-eligible for outbound after the no-response recycle window.

- Body CTA: invite the recipient to the inquiry-landing conversation, framed for self-serve evaluation rather than a scheduled call. Example: "If a quick self-serve walkthrough fits better than booking time, you can ask anything (or jump straight to a free workspace) here." — let the backend-appended landing URL be the only link
- Backup CTA in the body: reply only. Skip "scheduling fallback" lines like "or grab time on my calendar instead" — signup-mode projects have no scheduling link, and inviting a meeting contradicts the project's chosen CTA
- A reply path remains valid: a recipient who replies with questions instead of signing up still belongs in the response funnel. Don't write CTAs that close the door on a reply ("just sign up and you'll see")

## Customization Sources

- `overview`: Business overview of the prospect. Contains specific initiatives, services, and features
- `match_reason`: Why this prospect was selected as a target. Contains their challenges and needs

**Bad example (feels templated with only the opening changed):**
> I noticed your initiatives in IT/game talent development and am reaching out.
> These days, the ○○ industry is facing the challenge of △△... (identical for everyone below)

**Good example (written to the specific recipient):**
> I'm reaching out after seeing your robust career support program — including a joint job fair with roughly 700 companies and mock interviews.
> With a career support program at this scale, I imagine ensuring sufficient individual mock interview practice time for each student is a real challenge.

## Required Legal Disclosures

Outbound email is regulated by the recipient's jurisdiction (CAN-SPAM in the US, CASL in Canada, Japan's Act on Regulation of Transmission of Specified Electronic Mail, and others). The required disclosures — **sender identity (legal name), a valid physical/postal address, and an opt-out mechanism** — are appended automatically by the backend as a compliance footer on every send. **Do not add them to the body, and do not duplicate them in the sign-off** (a second address block yields a confused-looking footer). If `send_email_and_record` returns `412 Tenant compliance settings incomplete`, the footer can't be built — surface the message and have the user complete Workspace settings before retrying.

> Note: If targeting recipients in specific countries, research the applicable regulations for those jurisdictions before sending.

## Sending Method

Send and record via `mcp__plugin_leadace_api__send_email_and_record` (see SKILL.md for instructions).

## NG Patterns (Common Mistakes)

Check each email against these patterns that significantly lower response rates before sending.

| NG | Reason | Correct approach |
|---|---|---|
| Salutation is "Team" only | Perceived as mass outreach; likely to be ignored | Use "{organization name} Team" or "{full name}" |
| CTA is just a URL | Unclear what action is expected; clicking a URL is a high-friction action | Use question format to prompt a reply (URL is supplementary) |
| Forced, irrelevant, or fabricated proof | A bolted-on stat reads as filler and can erode trust | Use a proof point only when one genuinely fits the recipient; otherwise lean on specific personalization |
| Only opening is changed; rest is template | Recipient can tell it's not meant for them | Weave overview / match_reason throughout the body (in precision mode) |
| Near-identical body reused across prospects | Forms a content fingerprint Gmail spam-clusters → future sends get spam-foldered (even from a new domain) | Genuinely vary opener / structure / CTA per send; never ship identical boilerplate across a batch |
| Bare URL spam | Prone to spam filters | Embed naturally in text, or include just one URL in the CTA |
| Self-promotion comes first | Without empathy for the recipient's challenges, they won't read on | Structure as: their situation → challenge → solution |

## Notes

- Body text should be **75–150 words** (excluding sign-off and legal disclosures). Shorter emails have higher response rates
- One CTA per email
- No attachments (for first contact)
- **Default voice is casual, in the recipient's language**: write the way a real person emails — warm, direct, conversational, matching that language's politeness norms (English-standard casual for English; appropriately-polite natural Japanese for Japanese). No heavy signature block; close with a light sign-off in the email's language (`Best,` + your name for English; a natural Japanese close such as `よろしくお願いいたします` for Japanese). (The project's `email_template` document holds the body template; apply these voice rules when composing the outbound email from it.)
- Avoid spam trigger words: "free", "limited", "act now", etc.
