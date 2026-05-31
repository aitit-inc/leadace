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
- **Problem framing → solution**: Use the email template structure from SALES_STRATEGY.md as-is. Adjust only to swap in industry-relevant challenges
- **Overall body**: Maintain the template skeleton while varying the opening and problem framing per prospect

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
4. **Track record / proof** (1-2 lines): Quote at least one item from the "Track Record / Social Proof" section of SALES_STRATEGY.md. Specific numbers significantly increase credibility
5. **CTA** (1 line): Present exactly one next action
6. **Legal required disclosures**: Opt-out notice (see below)
7. **Signature**: Use the "Sender Information" section from SALES_STRATEGY.md

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

Outbound email regulations vary by country. Always comply with the laws applicable to your recipients' location (e.g., CAN-SPAM in the US, GDPR in the EU/UK, CASL in Canada, Spam Act in Australia). Common requirements across most jurisdictions:

- **Sender identification**: Sender's name or company name (acceptable if included in signature)
- **Physical or postal address**: A valid mailing address (acceptable if included in signature)
- **Opt-out mechanism**: A clear and easy way for recipients to opt out — e.g., "If you prefer not to receive further emails, please reply to this message." Process opt-out requests promptly

Verify that these are included in the signature block in SALES_STRATEGY.md. If the opt-out notice is missing, add it at the end of the email.

> Note: If targeting recipients in specific countries, research the applicable regulations for those jurisdictions before sending.

## Sending Method

Send and record via `mcp__plugin_leadace_api__send_email_and_record` (see SKILL.md for instructions).

## NG Patterns (Common Mistakes)

Check each email against these patterns that significantly lower response rates before sending.

| NG | Reason | Correct approach |
|---|---|---|
| Salutation is "Team" only | Perceived as mass outreach; likely to be ignored | Use "{organization name} Team" or "{full name}" |
| CTA is just a URL | Unclear what action is expected; clicking a URL is a high-friction action | Use question format to prompt a reply (URL is supplementary) |
| Zero track record / social proof | No basis for trust from a stranger | Quote at least one item from the track record in SALES_STRATEGY.md |
| Only opening is changed; rest is template | Recipient can tell it's not meant for them | Weave overview / match_reason throughout the body (in precision mode) |
| Bare URL spam | Prone to spam filters | Embed naturally in text, or include just one URL in the CTA |
| Self-promotion comes first | Without empathy for the recipient's challenges, they won't read on | Structure as: their situation → challenge → solution |

## Notes

- Body text should be **75–150 words** (excluding signature and legal disclosures). Shorter emails have higher response rates
- One CTA per email
- No attachments (for first contact)
- Polite but not overly formal. Excessive formality creates distance
- Avoid spam trigger words: "free", "limited", "act now", etc.
