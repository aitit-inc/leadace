# Environment Check & Project Selection

Shared procedure for verifying the LeadAce environment, picking or creating a project, and persisting environment status. Used by `/setup` (interactive) and `/lead-ace` (URL-driven onboarding chain).

The caller (the SKILL.md that `Read`s this file) provides:
- The user-facing framing and tone (interactive Q&A vs minimal-prompt chain)
- An optional `$0` argument (project name)
- An optional `$URL` (the user's homepage URL; used by `/lead-ace` for project naming)

This procedure is authoritative — execute the steps verbatim. Tools used: `mcp__plugin_lead-ace_api__*`, `Read`, `AskUserQuestion`, `Bash`.

## Step 1. Verify MCP Connection & Plugin Version

### 1-1. Server version & plugin compatibility

Call `mcp__plugin_lead-ace_api__get_server_version`. The response is `{ serverVersion, minPluginVersion }`.

`Read` `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and take the `version` field.

Compare semver component-by-component (split on `.`, parse each as integer, compare lexicographically). If the plugin version is **less than** `minPluginVersion`, **abort** with:

> Your LeadAce plugin is too old (v<plugin-version>) for the current backend (requires ≥ v<minPluginVersion>). Run `/plugin update lead-ace@lead-ace` and then re-run the current command.

Otherwise continue. Hold `SERVER_VERSION`, `PLUGIN_VERSION`, `MIN_PLUGIN_VERSION`.

### 1-2. Auth & reachability

Call `mcp__plugin_lead-ace_api__list_projects`. Success proves: MCP reachable, OAuth token valid, user authenticated. Hold the result as `PROJECTS`.

If the call fails:
- Network/unreachable → "Cannot reach the LeadAce MCP server. Check network access to https://mcp.leadace.ai (or `LEADACE_MCP_URL` for self-hosters)." Abort.
- Auth/401 → "MCP authentication failed. Sign in again at https://app.leadace.ai, then retry; the plugin will re-prompt the OAuth flow." Abort.

## Step 2. Environment Detection

Run automatic detection first, then ask the user only what cannot be detected.

### 2-1. Gmail SaaS connection (auto)

Call `mcp__plugin_lead-ace_api__get_gmail_status`. Record `connected` (boolean) and `email` (when connected) as `GMAIL_STATUS`.

If not connected: "Open https://app.leadace.ai — a 'Connect Gmail' banner is shown at the top of the page while disconnected; connect to enable email sending. Without this, no emails can be sent — you can still proceed with form-only or SNS-only outreach." Do **not** abort.

### 2-2. Gmail MCP (claude.ai built-in) — ask

Use `AskUserQuestion`: "Have you connected the Gmail MCP in claude.ai? (Required for reply checking in `/check-results` and for auto-drafting replies to positive responses.)" — options: `yes` / `no` / `unsure`. Record as `GMAIL_MCP`.

### 2-2b. Workspace identity / compliance footer (interactive fill)

Call `mcp__plugin_lead-ace_api__get_tenant_settings`. Hold the response as `TENANT_SETTINGS`.

The mandatory fields for outbound sending are `legalName`, `physicalAddress`, and `defaultSenderCountry` — these are appended to every outgoing message's compliance footer (CAN-SPAM § 5(a)(5), CASL § 6 sender identification). When any is `(not set)`, every send-side endpoint refuses with HTTP 412.

**Fill the missing fields here, in this skill, before handing off.** Reaching `/outbound` only to discover the workspace is incomplete is a poor UX.

**Skip the prompts entirely when all three are already set.** Otherwise, ask for the missing fields in **one combined free-text prompt** so the user only has to type once:

> "I need three things for the email compliance footer (CAN-SPAM § 5(a)(5)). Paste all of them in one go — separator/format is up to you:
> 1. Legal name — registered business / legal name, e.g. 'Acme, Inc.' or 'Jane Doe' for a sole proprietor.
> 2. Physical mailing address — CAN-SPAM requires a real postal address; a P.O. box or registered agent address is fine.
> 3. Sender country — your country as an ISO 3166-1 alpha-2 code (US, CA, JP, DE, GB, …) or the country name; recorded for the compliance footer. Note: outbound currently delivers only to recipients in **US / CA / JP**, but you can send from anywhere.
>
> Reply 'skip' to configure later at https://app.leadace.ai/workspace-settings ."

List only the fields that are still `(not set)` so the user is asked exactly for what's missing; omit any bullet whose field is already filled.

Parse the user's reply locally:
- Legal name and physical address are taken verbatim (trim whitespace).
- Sender country: accept any ISO 3166-1 alpha-2 code (the backend stores any `^[A-Z]{2}$`). If the user typed a country name, do a best-effort map to the alpha-2 code (`Japan` / `日本` → `JP`; `United States` / `USA` / `アメリカ` → `US`; `Canada` / `カナダ` → `CA`; `Germany` / `Deutschland` / `ドイツ` → `DE`; etc.). If you can't confidently resolve it to a 2-letter code, ask once for clarification ("Could you give me the ISO alpha-2 country code? E.g. US, JP, DE."). Don't reject codes outside US/CA/JP — sender country is independent from the recipient-delivery allowlist.

After parsing, call `mcp__plugin_lead-ace_api__update_tenant_settings` once with all the newly collected values in a single payload (pass `defaultSenderCountry` as the two-letter code, not the label). Trust the tool's "Compliance ready." reply or re-fetch to confirm. Refresh `TENANT_SETTINGS` in memory after the update.

If the user declines to provide a value (says "skip" / "later"), record that in the Step 5 completion report as a prominent warning with the URL `https://app.leadace.ai/workspace-settings` for later self-service. Do **not** abort — build-list / strategy / evaluate work fine with compliance unset; only `/outbound` and `/daily-cycle` will be blocked.

Mention the current US/CA/JP recipient scope once in the completion report so the operator's targeting matches the send-time guardrail.

### 2-3. Claude in Chrome extension — ask

Use `AskUserQuestion`: "Are you using the Claude in Chrome extension? (Required for contact-form submission and SNS DMs in `/outbound`, plus SNS reply checking in `/check-results`.)" — options: `yes` / `no` / `unsure`. Record as `CHROME_EXT`.

**Caller may relax these prompts**: when invoked from `/lead-ace`'s onboarding chain, the caller can default to `unsure` for 2-2 and 2-3 without asking, to keep the chain flowing. The user can re-run `/setup` later for explicit confirmation. State this assumption in the completion report (Step 5) when applied.

### 2-4. Local fetch toolchain (auto)

`scripts/fetch_url.py` (used by `/build-list` and `/strategy` for web research) Jina-fetches a page, then shells out to the `claude` CLI for Haiku extraction. Both `python3` **and** `claude` must be on PATH. Detect each with `Bash`:

```bash
python3 --version 2>&1
claude --version 2>&1
```

- Both exit 0 → `LOCAL_FETCH = { available: true, python: "<output>", claude: "<output>" }`
- Either non-zero / not found → `LOCAL_FETCH = { available: false, missing: [<which>] }`

The script uses standard-library only (no `pip install`), so a working `python3` + the Claude CLI are the only requirements. When unavailable, downstream skills fall back to `WebFetch` and skip candidates that return 403 — surface this as a non-blocking warning in the completion report (mention which of `python3` / `claude` is missing). Do **not** abort.

## Step 3. Pick or Create a Project

### 3-1. With `$0` (project name provided)

- If `$0` matches an existing project from `PROJECTS` → use it as-is. Set `PROJECT_NAME = $0`.
- If `$0` does not exist → call `mcp__plugin_lead-ace_api__setup_project` with `name: "$0"`.
  - On `Project limit reached` → tell the user "Free plan allows 1 project. Delete the existing one with `/delete-project` or upgrade your plan." and **abort**.
  - Set `PROJECT_NAME = $0`.

### 3-2. Without `$0`

- If exactly one project exists → use it. Set `PROJECT_NAME` to that.
- If multiple exist → ask via `AskUserQuestion` which to use, with one option per project plus `Create new`.
- If none exist or user picks `Create new`:
  - **If `$URL` is provided** (onboarding chain): derive a default name from the URL (`https://example.com` → `Example`). Confirm with the user in 1 line; suffix with a number if the name conflicts.
  - **If `$URL` is not provided**: ask the user for a project name in plain text (do not use `AskUserQuestion` for free-text input).
  - Then call `setup_project` with `name: <answer>`. Set `PROJECT_NAME`.

## Step 4. Save Environment Status

Build a markdown document and save via `mcp__plugin_lead-ace_api__save_document` with `projectId: PROJECT_NAME` and `slug: "env_status"`. This is the source of truth that `/strategy` and other skills read — do not skip.

Document template (substitute the fields from `GMAIL_STATUS`, `GMAIL_MCP`, `CHROME_EXT`, and the current local time):

```markdown
# Environment & Tool Status

Captured: <YYYY-MM-DD HH:MM> via /setup or /lead-ace.

| Capability | Status | Detail |
|---|---|---|
| LeadAce MCP | connected | (verified by list_projects) |
| Gmail send (SaaS) | connected / not connected | <email when connected> |
| Gmail MCP (replies) | yes / no / unsure | from user |
| Claude in Chrome (forms + SNS) | yes / no / unsure | from user |
| Local fetch toolchain (python3 + claude) | available / unavailable | <python / claude versions, or which is missing> |

## Channel tool capability implied by the above

(Tool capability only — which channels are *technically* usable given the connected tools. The outbound allowlist — which channels the project actually sends through — is controlled separately in Project Settings → `outboundChannels`.)

- Email: <available / unavailable — Gmail SaaS connection required>
- Form submission: <available / unavailable — Claude in Chrome required>
- SNS DM: <available / unavailable — Claude in Chrome required>
- Reply checking: <automated via Gmail MCP / manual fallback>
- Local URL fetch (build-list / strategy research): <local fetch tool available / web-fetch fallback only — some sites with WAF will return 403 and be skipped>
```

Use `Bash` `date '+%Y-%m-%d %H:%M %Z'` for the timestamp.

## Step 5. Hand-off to caller

Return control to the caller with:
- `PROJECT_NAME`
- `GMAIL_STATUS`, `GMAIL_MCP`, `CHROME_EXT`, `LOCAL_FETCH` (for downstream use)
- A capability summary the caller can include in its completion report:
  - Project in use (`PROJECT_NAME`)
  - Email send: <available / unavailable>
  - Form / SNS: <available / unavailable>
  - Local URL fetch: <local fetch tool / web-fetch fallback only>
  - Most prominent missing capability (if any), with the fix-it action

The caller composes its own user-facing completion message; this procedure does not print one.
