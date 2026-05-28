# Contact Enrichment Reference

A procedure for exploring prospect candidates' official websites to retrieve contact information (email addresses and inquiry form URLs).

## Input

A list of prospect candidates. Each candidate includes at minimum:
- `name`: Prospect name (school name, company name, etc.)
- `website_url`: Official website URL
- `overview`: Business overview
- Other information already retrieved in build-list Phase 1 (organization_name, industry, department, country, etc.)

## Exploration Procedure

For each candidate, explore in the following order. **Prioritize finding an email address** — only look for a form URL if no email is found. Limit exploration to **a maximum of 8 pages** per candidate (extendable to **a maximum of 12 pages** if no email is found in step 2).

**Use `fetch_url.py` for page retrieval (do not use WebFetch):**
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fetch_url.py --url "<URL>" --prompt "<extraction instruction>" --timeout 15
```

### 1. Understand Site Structure (Always do this first)

First, retrieve the **top page** with `fetch_url.py` and check:
- **Check for sales refusal notices (highest priority)**: Look for text like "No sales emails", "Please refrain from sales inquiries", "No solicitation", etc. **If found, stop the contact search** and set `"do_not_contact": true` and `"notes": "Site states no sales outreach: {matching text}"` in the output JSON, then proceed to the next candidate
- Whether the header/footer contains an email address (if so, stop here)
- From the navigation/footer link list, identify pages likely to contain contact information

**Examples of pages that often have contact info:**
- "Inquiry", "Contact" (direct)
- "Company Profile", "About", "Corporate Info" (often contains a main contact email)
- "For Business Customers", "Partner Recruitment", "Business Collaboration" (B2B-facing)
- "Access", "Location" (sometimes listed alongside address)
- "Sitemap" (can reveal hidden contact pages)

**Prioritize candidate pages** from the top page navigation and access them in order.

### 2. Search for Email Address

If an email is found in the top page header/footer in step 1, stop here. If not, **before diving deeper into the official site**, conduct an external search first (often more efficient than internal site exploration).

#### 2a. External Search (Do this first)

Check the "Prospect Discovery Sources" section of SALES_STRATEGY.md for the specific platforms and directories to use. Then search with WebSearch using 1-2 queries:
- `"{company name}" email address` or `"{company name}" contact`
- Search on press release / news sites listed in SALES_STRATEGY.md (press releases often include PR contact emails)

Priority sources to check (based on SALES_STRATEGY.md's "Prospect Discovery Sources"):
- **Press release / news sites** listed in SALES_STRATEGY.md — high rate of PR contact emails
- **Company databases / startup databases** listed in SALES_STRATEGY.md — company pages often have contact info
- **Industry directories and corporate information sites** listed in SALES_STRATEGY.md

If found here, stop the search. If not, proceed to step 2b.

#### 2b. Internal Site Exploration

Check the pages identified in step 1 one by one using `fetch_url.py`. Stop as soon as an email address is found.

Search tips:
- Look for general contact emails like `info@`, `contact@`, as well as personal contact emails
- Which to prefer: follow the policy in SALES_STRATEGY.md (if no policy, use whatever is found)
- Extract `mailto:` links found on the page
- News/press release pages sometimes list PR contact emails
- Privacy policy footers sometimes list an administrator email

### 3. Search for Inquiry Form URL (Only if no email found)

Only if no email address was found, look for an inquiry form. Use the link list from step 1 to find an appropriate form page.

**Appropriate forms (acceptable to register):**
- General inquiry forms such as "Inquiry" or "Consultation"
- B2B-oriented forms such as "For Corporate Clients" or "Business Partnership"

**Inappropriate forms (do not register):**
- If the form page states "No sales inquiries" or "Please refrain from sales outreach" → set `do_not_contact: true`
- Forms for specific purposes: "Request materials", "Admission inquiry", "Job application", "Trial signup", etc.
- Feedback-only forms: "Comments/suggestions", "Customer feedback", etc.
- Chat-only channels (no URL to save for auto-fill)
- Forms restricted to existing customers or policyholders
- Forms requiring unnecessary personal information (phone number, date of birth, etc.) as required fields
- 404 or broken form links

When registering a form URL, actually access the page to check the form type and required fields before deciding.

**Form type classification (form_type):** When registering a form URL, determine and record the `form_type` from the page source using the following criteria. Used by the outbound phase to determine channel strategy and processing method.

| form_type | Detection Criteria | Handling in outbound |
|---|---|---|
| `google_forms` | URL contains `docs.google.com/forms` | Submit via formResponse POST (high success rate) |
| `native_html` | Standard `<form>` tag, not iframe-embedded | Submit via browser automation |
| `wordpress_cf7` | HTML has `class="wpcf7-form"` or URL contains `wpcf7` | Browser automation; fallback to REST API on failure |
| `iframe_embed` | Form is embedded in an `<iframe>` (HubSpot, Marketo, etc.) | Difficult to submit; skip recommended |
| `with_captcha` | reCAPTCHA / hCaptcha / Turnstile script tags present | Cannot submit; skip |

Determine from `fetch_url.py` results (only from information visible when the form page is opened). If multiple conditions apply, use the more restrictive one (e.g., native_html + with_captcha → `with_captcha`).

### 4. Check for Contact Person Name (If Available)

During the contact search process, record a contact person name (representative name, PR contact name, etc.) **only if clearly identified**. Used for personalizing email salutations.

- Retrieve name when explicitly stated such as "CEO John Smith" or "PR Contact Jane Doe"
- Do not record guesses or ambiguous information (sending to the wrong name is counterproductive)
- Do not open additional pages just to find a contact name. Only record if naturally found during the contact search

### 5. Check SNS Accounts (If Time Permits)

If SNS links (Twitter/X, LinkedIn, etc.) are found on the official website, retrieve them. However, email/form search takes priority — SNS accounts are secondary if found.

## Output

For each candidate, return retrieved information in JSON format. **Field names must strictly follow the format below** (the DB registration script expects these exact names):

```json
[
  {
    "name": "Company A",
    "organization_name": "Company A Legal Name (if different from name)",
    "department": null,
    "contact_name": "John Smith",
    "website_url": "https://a.com",
    "overview": "Business overview",
    "industry": "Industry",
    "country": "US",
    "email": "info@a.com",
    "contact_form_url": null,
    "form_type": null,
    "sns_accounts": {"x": "@a_official"},
    "match_reason": "...",
    "priority": 3
  }
]
```

**Field name notes:**
- Contact person name: `contact_name` (only if clearly identified; omit or null if unknown)
- Form URL: `contact_form_url` (not `form_url`)
- SNS: `sns_accounts` (JSON object, e.g., `{"x": "@handle", "linkedin": "URL"}`; not `sns_url` or `sns_type`)
- `priority` is a numeric value 1-5 (not a string like "high"/"low")
- `form_type`: Form type (`"google_forms"` / `"native_html"` / `"wordpress_cf7"` / `"iframe_embed"` / `"with_captcha"` / `null`). Null if `contact_form_url` is null
- `do_not_contact`: Set to `true` if the site has a sales refusal notice (omit or `false` otherwise)
- `notes`: Supplementary information such as reason for do_not_contact (optional)
- `organization_name`: Legal entity name if different from `name` (e.g., a holding company that operates multiple brands)

**Other:**
- If `email` is found, `contact_form_url` is not needed (can be null)
- If neither is found, return both as null (register anyway; will be skipped during outbound)
- Preserve `match_reason`, `priority`, and other information passed from Phase 1
- **Candidates with do_not_contact detected should still be registered** (to avoid revisiting the same site). They will be registered with `do_not_contact: true` and thus excluded from outbound
