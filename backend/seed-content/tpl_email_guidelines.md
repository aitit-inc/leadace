# Email Writing Guidelines

Every outbound email is written for one named recipient, in the project's `targetLanguage` (`get_project_settings`) — it overrides any language phrasing in project documents. Voice is casual: warm, direct, the way a real person emails.

## Shape

Pick by whether you have a genuine finding about *this* recipient — real, specific, checkable, source nameable in plain words. Never inflate a generic industry claim into one.

**Value-first** (a finding exists) — hand over finished work instead of asking for time. The detail travels in the reply, never behind a link.

> Hi {first name},
> While looking at {their public artifact}, I noticed {one concrete, checkable finding}. In {their context} that usually means {consequence in their terms}.
> We {one-sentence offer}. I put together a short breakdown of this for {company} — want it? Just reply and I'll send it over.

**Peer note** (no finding) — a specific real observation, one plain sentence on the offer, a reply-only CTA.

> Hi {first name},
> Saw {a specific, real thing they shipped or did} — {one genuine, specific reaction}. Since you're {their current context}, thought {your offer} might be relevant: it {one concrete thing it does for them}.
> Worth a quick reply to compare notes?

These are shapes, not text: reword the connective phrasing and the CTA every send.

## Hard rules

The server refuses a send that breaks the mechanical half of these — an unfilled placeholder, the platform host or the CTA URL in the body, a footer written into the body, a near-duplicate of a recent body. It says which one; fix the body and retry.

- **Link-free by default in a cold first-touch body.** A link to a low-reputation domain is the strongest spam signal we have measured. The platform host (the app domain every workspace's inquiry and opt-out links share) is refused outright — it reaches recipients only as the backend-appended inquiry-landing URL. Your own site is allowed but carries its reputation cost; if a link is genuinely unavoidable, prefer a single recipient-trusted, well-aged domain (`calendly.com`, `github.com`).
- **No near-duplicates.** Vary opener, structure, paragraph order and CTA across prospects; never re-send boilerplate, including the non-personalized parts. The shapes above are structures to reword, not text to send.
- **One CTA, and it is a reply.** A reply also outperforms a click as an engagement signal.
- **Legal disclosures come from the backend footer** (legal name, physical address, opt-out). Never put them in the body or the sign-off.
- **Never emit a placeholder, merge token or QA leftover.** Missing datum → rewrite the sentence without it. ({Curly braces} here are authoring slots, never literal output.)
- **Never name the outreach machinery** — "cold email", "outreach", "sequence", "sender reputation", "deliverability", or calling the reader a "prospect". Exception: when that vocabulary is the *product's* own subject matter, it describes the product, never this email.
- **Salutation** names the person when `contact_name` exists, in the form that language uses (`Hi {first name},` in English; full name with the honorific in Japanese), else "{organization name} team". Bare "Team" is prohibited.
- No spam-trigger words ("free", "limited", "act now"). No attachments on first contact.

## Subject

40–60 characters, scannable on mobile, carrying a recipient benefit or challenge, different for every prospect. Avoid "Proposal" / "Announcement" / "Notice". `message_variants` owns subject patterns server-side; SALES_STRATEGY.md is not a source for them.

## Body

50–110 words excluding sign-off and footer; a peer note is often 50–70. Cut anything that is not about the recipient or one concrete point about your offer.

Whatever the opener — a variant's brief or the shapes above — say what you offer and why this recipient within the first few sentences. By default lead with their situation, never the product, and say what the offer does *for them* in one concrete sentence — never a feature list. Include a proof point (from SALES_STRATEGY.md "Track Record / Social Proof") only when one genuinely fits; a short honest ask beats forced credentials.

Personalization comes from the prospect's `overview` and `matchReason`, woven through the whole body — an email with only its opening changed reads as not written for them.

Close light: a one-line sign-off in the send language (`Best,` for English) plus your name from SALES_STRATEGY.md "Sender Information", role only if it helps. No signature block and no company line — the footer already carries the legal identity.

## CTA

Ask a question ("Could we find 15 minutes next week?"), not "See details here" or "Please contact us".

**Micro-reply escape hatch** (recommended on cold first-touch): one line turning the two common "no"s into a one-word reply — e.g. `Wrong person? Just reply "NOT ME". Bad timing? Reply "LATER".` The tokens are literal server-side matches, fixed per language (en: `NOT ME` / `LATER`; ja: `担当違い` / `またの機会に`); the sentence around them varies every send. Promise only what happens: LATER → we return later, NOT ME → we stop.

**Meeting mode**: a scheduling link may go inline only when inquiry landing is off — it follows the CTA question, never stands alone. With inquiry landing on, the backend-appended landing URL is the only link.

**Signup mode** (`inquiryCtaType: signup`): the signup URL never appears in the body — inlining it lets the recipient bypass the landing page, so the click is never recorded. Invite them to the landing conversation instead (the backend appends its URL), keep reply as the backup, and offer no scheduling fallback — these projects have no scheduling link.

When inquiry landing is off, do not reference or invent a landing URL.
