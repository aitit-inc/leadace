# Email Template

First-contact outreach template. English-standard and casual: write the way a real person emails — warm, direct, conversational. 75–150 words, one CTA, a light sign-off (never a heavy signature block). The backend appends the compliance footer (legal name, physical address, unsubscribe) and any inquiry / scheduling link automatically — never put those in the body.

This is the default starting point. `/leadace` onboarding generates each project's `email_template` document from this, and the operator can customize it afterward (in the plugin via `save_document`, or in the web app under Documents → Email Template).

---

Subject: {6–8 words naming the recipient's situation or a concrete benefit}

Hi {first name, or "{Organization} team" if no name},

{Opening (1–2 lines): why you're reaching out to *them* — something specific (a recent signal, their overview, the match reason). Not a generic "I came across your site".}

{What you do (1–2 lines): plainly what you offer and the problem it solves for someone like them.}

{Proof (optional, 1 line): a number or a comparable customer — only if one genuinely fits.}

{CTA (1 line, a question): one next action. With inquiry landing on, invite them to the inquiry conversation (the link is appended automatically — don't paste a URL); otherwise ask for a reply or a short call.}

Best,
{Your name}
