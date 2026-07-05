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

## Links: the dominant spam trigger — keep cold mail link-free

A link to a low-reputation domain — above all the shared app domain that every tenant's mail carries — is the single strongest spam signal we have measured: identical mail inboxes when the link is removed and lands in spam when it is present, regardless of the sending domain. So:

- **Put NO links in a cold first-touch body.** No landing page, no signup URL, no "book a demo" link, no tracking/redirect link. The backend footer carries a link-free, reply-based opt-out by default — never add an unsubscribe URL yourself either.
- **Make the CTA a reply, not a click.** "Worth a quick reply?" / "Open to a 15-min chat — just reply and I'll send times." A reply is also a stronger engagement signal than a click.
- **If a link is genuinely needed**, use a recipient-trusted, well-aged domain (e.g. `calendly.com`, `github.com`), never our own new/shared domain — and only one. A high-reputation link like `github.com` has been observed to reach the primary inbox — but only from a dedicated, well-warmed sending domain. From a new, shared, or reputation-burned sending domain, assume any link still costs deliverability.
- The inquiry-landing conversation link is **opt-in per project and off by default**; when it is off, do not reference or invent a landing URL.

## Subject Line

- **40–60 characters (6–8 words)** is optimal. Keep it scannable on mobile
- Convey recipient benefits or challenges
- Avoid generic subjects like "Proposal", "Announcement", "Notice"
- Vary the subject for each prospect. Never use the same subject for all outreach
- **If SALES_STRATEGY.md defines subject line patterns or A/B test instructions, always follow them**
- Examples: "Your school's career support × AI interviews", "Case study: 30% reduction in hiring costs"

## Body Structure

This numbered list is the maximal checklist, not a length mandate. For a cold first-touch, the link-free peer-note shape (good example under Customization Sources) is the default target: compress steps 2–4 into one or two sentences rather than expanding each to its full line count.

1. **Opening greeting** (1-2 lines): Use "{full name}" if the prospect's `contact_name` is in the DB, otherwise use "{organization name} Team" — using "Team" alone reads as mass outreach and is prohibited. Briefly explain why you're reaching out
2. **Problem framing** (2-3 lines): Specifically address the challenge the recipient likely faces
3. **Solution** (2-3 lines): How your service solves it
4. **Proof (optional, 1 line)**: If you have a concrete, relevant proof point — a number or a comparable customer from the "Track Record / Social Proof" section of SALES_STRATEGY.md — include one short line; specifics build credibility. If none fits naturally, skip it. A short honest ask beats forced credentials
5. **CTA** (1 line): Present exactly one next action
6. **Legal required disclosures**: Opt-out notice (see below)
7. **Sign-off** (1-2 lines): Close light, in the email's language — a short sign-off (`Best,` for English; a natural Japanese close such as `よろしくお願いいたします` for Japanese) on one line, your name on the next; add your role only if it helps. No company/product line under your name — the compliance footer already shows the legal company name, and repeating it turns a light close into a marketing signature. Do **not** paste a full signature block (phone, postal address, multiple URLs): cold email closes light, and the backend appends the email footer automatically (by default: legal name, physical address, unsubscribe). Take the name/role from the "Sender Information" section of SALES_STRATEGY.md

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

**Good example (link-free peer note — the shape that lands in the primary inbox; vary the wording every send, never copy this verbatim):**
> Hi {first name},
> Saw {a specific, real thing they shipped or did} — {one genuine, specific reaction}. Since you're {their current context}, thought {your offer} might be relevant: it {one concrete thing it does for them}.
> Worth a quick reply to compare notes?

The strength is a *specific, real* observation (not "I noticed your industry faces…"), one plain sentence on the offer (not a feature list), and a reply-only CTA. Keep it ~50–70 words; the backend appends the compliance footer, so close with just a light sign-off. The connective phrasing and the CTA line are must-vary parts — never reuse this example's wording (including "Worth a quick reply?") verbatim in a real send.

## Required Legal Disclosures

Outbound email is regulated by the recipient's jurisdiction (CAN-SPAM in the US, CASL in Canada, Japan's Act on Regulation of Transmission of Specified Electronic Mail, and others). The required disclosures — **sender identity (legal name), a valid physical/postal address, and an opt-out mechanism** — are carried by the footer the backend appends on every send. The default footer includes all three; when a project customizes the footer text (project settings → Email footer), keeping them there is the operator's responsibility. Either way, **do not add them to the body, and do not duplicate them in the sign-off** (a second address block yields a confused-looking footer). If `send_email_and_record` returns `412 Tenant compliance settings incomplete`, the footer can't be built — surface the message and have the user complete Workspace settings before retrying.

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
| Product described as a feature list / paragraph-long blurb | Reads as an ad → fires the human spam-report reflex and Gmail's promotional clustering | One concrete sentence on what it does for *them*; lead with their situation, not the product |
| Names the outreach channel/machinery in the body ("cold email", "sender reputation", calling the reader a "prospect") | Talking about the spammy channel inside it trips content filters and reads as tool-generated | Describe the recipient's world and your offer in plain words; never reference outreach mechanics |
| A placeholder / merge token or leftover QA/"Test" string ships | The clearest "automated blast" tell → instant distrust or a spam report | Rewrite without the missing datum; never emit a raw token |

## Notes

- Body text should be **short — roughly 50–110 words** (excluding sign-off and legal disclosures); a genuine peer note is often ~50–70. Shorter, specific emails have higher response rates and a smaller content-fingerprint surface — cut anything that isn't about the recipient or one concrete point about your offer
- One CTA per email
- No attachments (for first contact)
- **Default voice is casual, in the recipient's language**: write the way a real person emails — warm, direct, conversational, matching that language's politeness norms (English-standard casual for English; appropriately-polite natural Japanese for Japanese). No heavy signature block; close with a light sign-off in the email's language (`Best,` + your name for English; a natural Japanese close such as `よろしくお願いいたします` for Japanese). (The project's `email_template` document holds the body template; apply these voice rules when composing the outbound email from it.)
- Avoid classic spam-trigger words ("free", "limited", "act now")
- **Don't name the outreach channel or its machinery inside the email.** Words like "cold email", "outreach", "sequence", "sender reputation", "deliverability", "sender infrastructure", or calling the reader a "prospect"/"lead" trip content filters (rare n-grams learned from bulk-mail tools) *and* expose the mass-send mechanics — write as if this is the one email you personally sent today. Exception: when these words are the *product's* own domain vocabulary (e.g. the offer is sales or outreach tooling), use them to describe the product — never to describe this email itself or the process that produced it
- **Never let a placeholder or merge token ship** ("{Company}", "{First name}", a leftover "Test"/QA artifact, an unrendered field). If a personalization datum is missing, rewrite the sentence without it — a visible token is the clearest "automated blast" tell. ({Curly braces} in this document are authoring-time slots to fill with real data, never literal text to emit)
