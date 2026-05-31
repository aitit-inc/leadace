# Contact Form Submission Procedure

Use the `mcp__claude-in-chrome__*` tools to fill in and submit forms. **This procedure assumes SKILL.md §4 has already allocated the pre_send outreach log row** via `record_outreach_with_inquiry` and confirmed `status === 'pre_send'` (draft mode never reaches this file). The flow below resolves that row via `update_outreach_status` on success or failure. See `claude-in-chrome-guide.md` for the full tool reference.

**Important: Submit forms only once.** After clicking the submit button, do not retry for any reason. Verify outcome via `read_network_requests` and page state.

## Basic Flow

Set up the tab and navigate per the Quick start in `claude-in-chrome-guide.md`, then:

```
1. mcp__claude-in-chrome__read_page { tabId }
   -> identify the form, fields, and submit button refs
   -> run the pre-submit screening before any form-fill (see "Pre-submit
      Screening" below): sales refusal notice, no form on page, CAPTCHA,
      iframe-embedded form. If any matches, resolve the pre_send row with
      update_outreach_status({ status: "failed", errorMessage }) and STOP.

2. mcp__claude-in-chrome__form_input × N  (call in parallel — no order dependency)
   { tabId, ref: "ref_5",  value: "Acme Corp" }
   { tabId, ref: "ref_8",  value: "山田 太郎" }
   { tabId, ref: "ref_12", value: "info@example.com" }
   { tabId, ref: "ref_15", value: "Service inquiry" }   // select uses string
   { tabId, ref: "ref_20", value: <finalBody> }          // textarea — use finalBody verbatim from SKILL.md §4
   { tabId, ref: "ref_22", value: true }                 // checkbox / radio

3. mcp__claude-in-chrome__read_network_requests { tabId, clear: true }
   -> initialize tracking BEFORE the submit click

4. mcp__claude-in-chrome__computer { tabId, action: "left_click", ref: <submit ref> }

5. Verify completion (see "Submission Completion Check" below) and resolve
   the pre_send row via update_outreach_status (sent / failed).
```

`finalBody` from SKILL.md §4 already contains the inquiry-landing URL footer — feed it into the form's free-text / message field verbatim. Do not strip it or re-embed the URL elsewhere.

## Pre-submit Screening (Safety Net)

Run during step 1 of the Basic Flow, before any `form_input` call. If any check below matches, resolve the `pre_send` row with `update_outreach_status({ status: "failed", errorMessage: "<reason>" })` and skip the rest of the flow. The row's in-flight quota reservation is automatically refunded on the `failed` transition; the inquiry token associated with the row is wasted but harmless.

**Sales refusal notice.** Look for any text stating "No sales inquiries", "Please refrain from sales outreach", "営業お断り", "勧誘お断り", etc. The accessibility tree from `read_page` includes most labels and headings; for body copy, also try `find { query: "sales refusal notice" }` or `javascript_tool { text: "document.body.innerText" }` and grep.

If found:
- `update_outreach_status` with `errorMessage: "Sales refusal notice found"`.
- `update_prospect_status` with `status: "inactive"`.

## Form Filling Policy

- Split the message appropriately to match the form's fields
- For "Inquiry type" fields, select options like "Service inquiry" or "Business partnership inquiry"
- Retrieve basic info (organization name, full name, email, phone number) from BUSINESS.md
- In free-text fields, enter a customized message following the same email guidelines, but adapted to be concise for forms
- Use `form_input { ref, value: true }` for privacy-policy / agreement checkboxes

## Submission Completion Check (Required)

After the submit click, verify in this order. **Never re-submit until verification is complete.**

### Step 1: Check the network result

```
mcp__claude-in-chrome__read_network_requests { tabId, urlPattern: <relevant>, limit: 30 }
```

Look for the form's POST:
- **HTTP 200 / 302** -> Submission successful
- **HTTP 4xx** -> Submission failed (validation or rejection)
- **HTTP 5xx** -> Treat as failed for the outreach log. **Note**: a small number of SaaS form backends (e.g. studio.design's `studiodesignapp.com`) return 5xx but still deliver the message asynchronously. If you suspect this, surface it in the report so the user can verify.
- **No POST visible** -> the submit click did not trigger submission. Re-check the form for missing required fields, then verify page state.

If there are many unrelated requests, narrow with `urlPattern` (a substring of the expected POST URL) before reading.

### Step 2: Sanity-check page state

```
mcp__claude-in-chrome__read_page { tabId }
```

The submission is **definitely successful** if any of:
- A thank-you page is displayed ("Thank you for your inquiry", "送信完了", etc.)
- URL has transitioned to a confirmation route (`/thanks`, `/complete`, etc.)
- The form has disappeared and a completion message is shown

### Processing Based on Verification Result

The row was allocated as `status: "pre_send"` in SKILL.md §4. It is **always** resolved by a follow-up `update_outreach_status` call:

**If submission was successful:** call `mcp__plugin_leadace_api__update_outreach_status` with the `outreachLogId` from SKILL.md §4 and `status: "sent"`. The server flips the prospect to `contacted` and confirms quota consumption.

**If submission failed (4xx, 5xx, or no POST):** call `mcp__plugin_leadace_api__update_outreach_status` with the `outreachLogId`, `status: "failed"`, and `errorMessage: "<reason>"` (e.g., `"HTTP 422 validation"`, `"no POST observed"`). The in-flight quota reservation is refunded and the server stamps `next_outreach_after` so the prospect drops out of `get_outbound_targets` for `noResponseRecycleDays` (default 90 days).

**Important:** Even on failure, do not re-submit to that form. Move on to the next prospect.

## Error Handling

All errors below resolve the existing `pre_send` row via `update_outreach_status({ status: "failed", errorMessage })`. The inquiry token allocated alongside the row is wasted in the skip case but harmless.

- **Form not found:** No `<form>` in `read_page` (detected during step 1 screening) -> `update_outreach_status` with `errorMessage: "no form on page"`.
- **Input validation error after submit:** Check `read_page` for inline error messages, then make **one** corrected re-submission attempt. Verify the re-submission via network as well. The original `pre_send` allocation stays valid until the final resolve — do not call `record_outreach_with_inquiry` again.
- **Page load timeout (before step 1 read_page):** `update_outreach_status` with `errorMessage: "page load timeout"`.
- **Page load timeout (after read_page but before submit):** `update_outreach_status` with `errorMessage: "page load timeout"`.

### When reCAPTCHA / hCaptcha or Similar is Present

If the form has reCAPTCHA, hCaptcha, Turnstile, or similar CAPTCHA (visible in `read_page` or `find { query: "captcha" }`), skip form submission during step 1 screening:

- `update_outreach_status` with `errorMessage: "Skipped due to reCAPTCHA"`.
- The prospect's status stays as `new` (the CAPTCHA may be removed in a future update).
- If another channel (email, SNS) is available, try that instead.

### For Google Forms

Submit Google Forms via a direct POST to the `formResponse` endpoint rather than browser UI interaction. This has a high success rate (no UI interaction needed, no CAPTCHA), and minimal context usage.

**Detection:**
- URL contains `docs.google.com/forms`
- Page source contains `FB_PUBLIC_LOAD_DATA_`

**Submission procedure** (SKILL.md §4 has already allocated the `pre_send` row and you have `finalBody` from that response):

1. **Extract entry IDs via `javascript_tool`** (replaces the old `fetch_url.py --raw` + Haiku flow — deterministic, no LLM call needed):

   ```
   mcp__claude-in-chrome__navigate { tabId, url: "https://docs.google.com/forms/d/e/{FORM_ID}/viewform" }

   mcp__claude-in-chrome__javascript_tool {
     tabId,
     action: "javascript_exec",
     text: "(() => { const data = window.FB_PUBLIC_LOAD_DATA_; const fields = data[1][1]; return JSON.stringify({ formId: location.pathname.match(/\\/forms\\/d\\/e\\/([^/]+)\\//)[1], title: data[1][8], fields: fields.map(f => ({ label: f[1], type: f[3], entries: Array.isArray(f[4]) ? f[4].map(e => ({ id: e[0], options: Array.isArray(e[1]) ? e[1].map(o => o[0]) : null })) : null })) }); })()"
   }
   ```

   Result shape:
   ```json
   {
     "formId": "1FAIp...",
     "title": "...",
     "fields": [
       { "label": "ラジオボタン", "type": 2, "entries": [{ "id": 1022372562, "options": ["オプション 1", ...] }] },
       { "label": "プルダウン",   "type": 3, "entries": [{ "id": 87339598,   "options": [...] }] },
       { "label": "チェックボックス", "type": 4, "entries": [{ "id": 1220516489, "options": [...] }] },
       { "label": "日付選択",     "type": 9, "entries": [{ "id": 1490458150, "options": null }] },
       ...
     ]
   }
   ```

2. **POST to the formResponse endpoint** via Bash:

   ```bash
   curl -s -o /tmp/gform_resp.html -w "HTTP: %{http_code}\n" \
     -X POST "https://docs.google.com/forms/d/e/{FORM_ID}/formResponse" \
     --data-urlencode "entry.XXXXXXX=value1" \
     --data-urlencode "entry.YYYYYYY=value2" \
     --data-urlencode "entry.YYYYYYY=value3"   # repeat the same entry.X for multi-checkbox
   grep -oE "回答を記録しました|response has been recorded" /tmp/gform_resp.html
   ```

   - HTTP 200 + the body containing `回答を記録しました` (or `Your response has been recorded.`) -> success
   - HTTP 200 without that marker usually means the form re-rendered with a validation error — check the response body.
   - HTTP 302 (redirect to confirmation page) also means success.

3. **Resolve the row.** Always call `mcp__plugin_leadace_api__update_outreach_status` with the `outreachLogId` from SKILL.md §4:
   - Success (HTTP 200 with the recorded marker, or HTTP 302) → `status: "sent"`.
   - Failure → `status: "failed"` plus a short `errorMessage` (e.g., `"Google Forms validation"` or `"HTTP <code>"`).

**Notes:**
- The order of form fields and their entry IDs may not be obvious. Cross-reference with the field `label` in the JS extraction to map the correct entry IDs.
- Some forms with email collection enabled also require an `emailAddress` parameter.
- For checkbox fields, repeat `--data-urlencode "entry.X=optionA"` once per selected option.
