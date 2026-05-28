# Industry-Specific Email Template Collection

Referenced when generating the "Messaging" section of SALES_STRATEGY.md. Select the optimal pattern based on the user's target industry and customize it to their business information. Do not use templates as-is — always add substance based on user-specific information (USP, track record, pricing).

## First Outreach Emails by Industry

### IT/Web Industry
- Subject: Under 50 characters; include company name or a specific number
- Body: Under 75 words
- Tone: Direct and concise; language that resonates with technical people
- Structure: ① Company name mention (why you're reaching out) → ② Problem your service solves → ③ Specific numbers/track record → ④ CTA (propose 15-minute information exchange)
- Keep it natural and feel less like a "sales pitch" — frame it as "information exchange"

### Manufacturing Industry
- Subject: Include an industry-specific challenge
- Body: Under 100 words
- Tone: Polite and trust-focused; avoid jargon
- Structure: ① Polite greeting → ② Empathy with industry challenges → ③ Present a solution case → ④ Low-friction CTA (offer to send materials)

### Professional Services / Consulting
- Subject: Include specific ROI/cost reduction numbers
- Body: Under 75 words
- Tone: Logical, numbers-based, professional
- Structure: ① Respect for recipient's expertise → ② Common industry challenges (time pressure, differentiation) → ③ ROI presentation → ④ CTA (short consultation)

### E-commerce / Retail
- Subject: Sales/CVR/traffic numbers
- Body: Under 75 words
- Tone: Casual but results-oriented and energetic
- Structure: ① Specifically mention their shop/products → ② Suggest "you could sell more" → ③ Service improvement numbers → ④ CTA (demo/case study introduction)

### General (Any Industry)
- Subject: Under 40 characters; curiosity hook
- Body: 50–75 words
- Tone: Natural, not pushy
- Structure: ① Specifically mention the recipient's initiatives → ② One line connecting your service → ③ CTA ("Could we chat for 15 minutes?")
- Avoid: Long text, self-promotion, abstract phrases ("solve your challenges", etc.)

## Follow-up Emails

### First Follow-up for No Response (3–5 business days after initial send)
- Subject: "Re: {original subject}" (thread format)
- Body: Under 50 words (extremely short)
- Tone: Light, no pressure
- Structure: ① Light reminder of the original email → ② One new angle (case study, number, industry news) → ③ Considerate closing
- Avoid any sense of urgency or nagging

### Second Follow-up for No Response (Final contact)
- Subject: "Re: {subject}"
- Body: Under 30 words (minimal)
- Tone: Light, no lingering
- Structure: ① Signal of "last contact" → ② Future contact info → ③ Brief farewell
- Psychological effect: Explicitly stating "this is the last email" tends to increase response rates

### Response to Positive Reply + Meeting Proposal
- Speed: Send immediately (freshness matters)
- Body: Under 60 words
- Tone: Grateful + efficient
- Structure: ① Thank-you (specifically reference the recipient's comment) → ② "Would love to discuss in more detail" → ③ Three available time slots → ④ Scheduling link
- Include scheduling tool link (Calendly, Cal.com, etc.) if available

## Additional Patterns

### Referral Request Email
- Body: Under 75 words. Casual, tone adjusted to the relationship
- Structure: ① Recent update/greeting → ② Describe the target company profile → ③ Reason the referral benefits the recipient too → ④ Light ask
- No pressure. Stance is "if you happen to know anyone"

### Re-engaging Dormant Leads
- Subject: Casual question ("Long time no talk", etc.)
- Body: Under 75 words
- Structure: ① Reference past interactions → ② New development/update → ③ Soft re-proposal → ④ CTA
- Avoid: Negative framing ("You declined last time, but...")

## Selection Guidelines

When generating messaging during /strategy, select templates based on the following criteria:

1. **Clear target industry** → Base on the relevant industry-specific template
2. **Spans multiple industries** → Base on the general template; add industry-specific adjustment notes
3. **Follow-ups** → Include the common follow-up patterns in SALES_STRATEGY.md for all industries
4. **Never use templates as-is** → Always customize with the user's business information (USP, track record, price range)

## CTA Mode Notes (meeting / signup)

Outbound email bodies link only to the **inquiry-landing page**, regardless of the project's `inquiryCtaType`. The landing URL is appended automatically as the email footer by the backend — never paste a scheduling URL or signup URL inline in the body. The landing page itself renders the mode-specific button (Book a meeting / Sign up) and records the corresponding outcome (`lead` / `signup_clicked`). For body wording per mode (especially the "no scheduling fallback in signup mode" rule), see the `tpl_email_guidelines` master document's "Signup CTA mode" subsection.
