# Environment Check & Project Selection

Shared procedure for verifying the LeadAce environment and picking or creating a project. Used by `/leadace` (the setup / environment intent and the URL-driven onboarding chain).

Environment status is **live-detected, never persisted.** Gmail SaaS connectivity is queried at the moment it's needed (`get_gmail_status`); the local fetch toolchain is re-detected per run; Gmail MCP / Claude in Chrome are advisory (we inform the user they're needed, but never store a stale snapshot or gate on it). This procedure detects the current state for the onboarding completion report only — it does not save an `env_status` document.

The caller (the SKILL.md that `Read`s this file) provides:
- The user-facing framing and tone (interactive Q&A vs minimal-prompt chain)
- An optional `$0` argument (project name)
- An optional `$URL` (the user's homepage URL). Its presence means "this is the onboarding chain": it names the project (3-2) and suppresses every prompt here (2-2, 2-2b, 2-3), because the chain asks the user once, later, in one place.

This procedure is authoritative — execute the steps verbatim. Tools used: `mcp__plugin_leadace_api__*`, `Read`, `AskUserQuestion`, `Bash`.

## Step 1. Verify MCP Connection & Plugin Version

### 1-1. Server version & plugin compatibility

Call `mcp__plugin_leadace_api__get_server_version`. The response is `{ serverVersion, minPluginVersion }`.

`Read` `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and take the `version` field.

Compare semver component-by-component (split on `.`, parse each as integer, compare lexicographically). If the plugin version is **less than** `minPluginVersion`, **abort** with:

> Your LeadAce plugin is too old (v<plugin-version>) for the current backend (requires ≥ v<minPluginVersion>). Run `/plugin update leadace@leadace` and then re-run the current command.

Otherwise continue. Hold `SERVER_VERSION`, `PLUGIN_VERSION`, `MIN_PLUGIN_VERSION`.

### 1-2. Auth & reachability

Call `mcp__plugin_leadace_api__list_projects`. Success proves: MCP reachable, OAuth token valid, user authenticated. Hold the result as `PROJECTS`.

If the call fails:
- Network/unreachable → "Cannot reach the LeadAce MCP server. Check network access to https://mcp.leadace.ai (or `LEADACE_MCP_URL` for self-hosters)." Abort.
- Auth/401 → "MCP authentication failed. Sign in again at https://app.leadace.ai, then retry; the plugin will re-prompt the OAuth flow." Abort.

## Step 2. Environment Detection

Run automatic detection first, then ask the user only what cannot be detected.

### 2-1. Gmail SaaS connection (auto)

Call `mcp__plugin_leadace_api__get_gmail_status`. Record `connected` (boolean) and `email` (when connected) as `GMAIL_STATUS`.

If not connected: "Open https://app.leadace.ai — a 'Connect Gmail' banner is shown at the top of the page while disconnected; connect to enable email sending. Without this, no emails can be sent unless a custom SMTP mailbox is assigned to the project in the Web UI — you can still proceed with form-only or SNS-only outreach." Do **not** abort.

### 2-2. Gmail MCP (claude.ai built-in) — ask

Use `AskUserQuestion`: "Have you connected the Gmail MCP in claude.ai? (Required for reply checking in `/check-responses` and for auto-drafting replies to positive responses.)" — options: `yes` / `no` / `unsure`. Record as `GMAIL_MCP`.

### 2-2b. Workspace identity / compliance footer (read)

Call `mcp__plugin_leadace_api__get_tenant_settings`. Hold the response as `TENANT_SETTINGS`.

`legalName`, `physicalAddress`, and `defaultSenderCountry` are mandatory for sending — the first two render into every outgoing message's compliance footer (CAN-SPAM § 5(a)(5), CASL § 6 sender identification), `defaultSenderCountry` is workspace metadata (the sender's own country, unrelated to message language). While any is `(not set)`, every send-side endpoint refuses with HTTP 412. They are set in the Web UI only: https://app.leadace.ai/workspace-settings — never ask for the values in chat.

When any is `(not set)`, say so once here with that URL and carry it into the Step 4 hand-off as a prominent warning. Do **not** abort — build-list / strategy / evaluate work fine without them; only `/outbound` and `/daily-cycle` are blocked.

Mention the recipient-delivery scope once in the completion report (outbound currently delivers only to recipients in **US / CA / JP**; sending from any country is fine) so the operator's targeting matches the send-time guardrail.

### 2-3. Browser automation backend — ask

Use `AskUserQuestion`: "For `/outbound` browser automation, which do you have? Claude in Chrome handles **contact forms and SNS DMs** (plus SNS reply checking in `/check-responses`); any other browser-automation MCP you've configured (e.g. Playwright) handles **contact forms only**." — options: `Claude in Chrome` / `Other browser MCP` / `neither` / `unsure`. Record as `BROWSER_AUTOMATION` (`chrome` | `other` | `none` | `unsure`; pick `chrome` if the user has both). Capability: `chrome` → form + SNS; `other` → form only; `none`/`unsure` → email only.

**When `$URL` is set** (the onboarding chain), 2-2 and 2-3 are not asked — record both as `unsure` and report the assumption in the Step 4 hand-off. A first run must not open with a quiz about tools the user can connect later, and `/leadace` re-checks the environment on request.

### 2-4. Local fetch toolchain (auto)

`scripts/fetch_url.py` (used by `/build-list` and `/leadace` strategy drafting for web research) Jina-fetches a page, then shells out to the `claude` CLI for Haiku extraction. Both `python3` **and** `claude` must be on PATH. Detect each with `Bash`:

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
- If `$0` does not exist → call `mcp__plugin_leadace_api__setup_project` with `name: "$0"`.
  - On `Project limit reached` → tell the user "Free plan allows 1 project. Delete the existing one with `/delete-project` or upgrade your plan." and **abort**.
  - Set `PROJECT_NAME = $0`.

### 3-2. Without `$0`

- If exactly one project exists → use it. Set `PROJECT_NAME` to that.
- If multiple exist → ask via `AskUserQuestion` which to use, with one option per project plus `Create new`.
- If none exist or user picks `Create new`:
  - **If `$URL` is provided** (onboarding chain): derive the name from the URL (`https://example.com` → `Example`) and create it without asking — state the name in one line, don't stop for approval. Suffix with a number if the name conflicts.
  - **If `$URL` is not provided**: ask the user for a project name in plain text (do not use `AskUserQuestion` for free-text input).
  - Then call `setup_project` with `name: <answer>`. Set `PROJECT_NAME`.

## Step 4. Hand-off to caller

Return control to the caller with (held in memory — not saved as a document):
- `PROJECT_NAME`
- `GMAIL_STATUS`, `GMAIL_MCP`, `BROWSER_AUTOMATION`, `LOCAL_FETCH` (for the completion report)
- A capability summary the caller can include in its completion report:
  - Project in use (`PROJECT_NAME`)
  - Email send: <available / unavailable>
  - Contact forms: <available / unavailable> — from `BROWSER_AUTOMATION` (`chrome` or `other` → available)
  - SNS DMs: <available (Claude in Chrome) / unavailable> — `chrome` only
  - Local URL fetch: <local fetch tool / web-fetch fallback only>
  - Most prominent missing capability (if any), with the fix-it action

The caller composes its own user-facing completion message; this procedure does not print one.
