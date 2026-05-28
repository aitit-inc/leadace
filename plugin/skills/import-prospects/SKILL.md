---
name: import-prospects
description: "Use when the user asks to \"import prospects\", \"upload a list\", or has tabular contact data (CSV / Excel / SQLite / text) to load. Two modes: save as tenant-only assets (link later via /match-prospects) or link straight to a project."
argument-hint: "<input-file> [project-name] [skip|overwrite]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - mcp__plugin_lead-ace_api__list_projects
  - mcp__plugin_lead-ace_api__import_prospects_from_csv
---

# Import Prospects - Bring Your Own List

A skill that imports existing prospect / contact lists (CSV, Excel, SQLite, plain text, etc.) into LeadAce. The MCP server only accepts a **canonical CSV** (specific columns), so the LLM here is responsible for reading the user's arbitrary file, mapping it to the canonical schema, writing the canonical CSV, and uploading it.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Two import modes

- **Tenant assets only** (default for "name card lists" / "old CRM exports" / lists not tied to a single campaign): no `projectId` is sent to the upload tool. Prospects + organizations are saved at the tenant level. Use `/match-prospects <project>` afterwards to link the right ones into a specific project.
- **Linked to a project**: a `projectId` is sent; every row also carries a `matchReason` and is linked to that project via `project_prospects`. Use this when the list was assembled specifically for one campaign.

## Inputs

- `$0` — path to the source file (required). Any tabular format works (CSV, TSV, XLSX, XLS, ODS, SQLite, plain text with consistent delimiters).
- `$1` — project name (optional). If supplied, default to project-linked mode (still confirm with the user in step 1). Must already exist; create one with `/setup` first.
- `$2` — dedup policy: `skip` (default) or `overwrite`. With `skip` existing rows are left alone; with `overwrite` matched rows have their fields refreshed (and, in project mode, re-linked to the project).

## Canonical CSV schema

| Column | Required | Notes |
|---|---|---|
| `organizationDomain` | yes | Apex domain, e.g. `acme.com` |
| `organizationName` | yes | |
| `organizationWebsiteUrl` | yes | Must be a full URL |
| `name` | yes | Prospect display name (often the org name or department) |
| `overview` | yes | One-paragraph description of the prospect |
| `websiteUrl` | yes | Prospect-specific URL (often == organizationWebsiteUrl) |
| `matchReason` | yes\*\* | Why this prospect is a target. Required only in **project-linked** mode; ignored in tenant-only mode |
| `contactName` | no | |
| `department` | no | |
| `industry` | no | |
| `email` | no\* | |
| `contactFormUrl` | no\* | |
| `formType` | no | One of `google_forms`, `native_html`, `wordpress_cf7`, `iframe_embed`, `with_captcha` |
| `snsAccounts.x` | no\* | |
| `snsAccounts.linkedin` | no\* | |
| `snsAccounts.instagram` | no\* | |
| `snsAccounts.facebook` | no\* | |
| `notes` | no | |
| `priority` | no | Integer 1-5, default 3 |
| `doNotContact` | no | Boolean. `1` / `true` / `yes` / `on` (case-insensitive) → DNC; `0` / `false` / `no` / `off` → not DNC; empty cell omitted. |

\* At least **one** of `email`, `contactFormUrl`, or any `snsAccounts.*` is required per row.
\*\* Tenant-only imports may omit the `matchReason` column entirely. Linking happens later via `/match-prospects`, which writes a fresh `matchReason` per project.

Maximum 1000 data rows per import. Split larger files into multiple calls.

## Steps

### 1. Decide the import mode

Use `AskUserQuestion` to pick between the two modes — do not assume. Default the first option to:
- **"Save as tenant assets only"** when `$1` is empty.
- **"Link to a project"** (with the named project pre-selected) when `$1` is provided.

Options:

- **Save as tenant assets only** — prospects are stored at the tenant level. Use this for name-card / old-CRM / general lead lists where the right project is unclear. Linking happens later with `/match-prospects`.
- **Link to a project** — every row is linked to a project via `project_prospects`. Use this when the list was assembled for one specific campaign.

If the user picks **Link to a project**:
- if `$1` is given, use it as `PROJECT_NAME`.
- otherwise call `mcp__plugin_lead-ace_api__list_projects` and ask via `AskUserQuestion` (or use the only project if there's just one).
- if there are zero projects, abort: "No projects yet. Run `/setup <project-name>` first, or re-run this skill in tenant-asset mode."

If the user picks **Save as tenant assets only**, set `PROJECT_NAME = null` and skip every project-resolution step below.

### 2. Read the source file

If `$0` is empty, abort and ask the user for a file path.

Inspect the file by extension:
- `.csv` / `.tsv` / `.txt` — `Read` directly
- `.xlsx` / `.xls` / `.ods` — convert to CSV via `Bash` using whatever the user's environment has (`python3 -c "import pandas; pandas.read_excel('$0').to_csv('/tmp/leadace_import_src.csv', index=False)"` is a reasonable default; `ssconvert` from gnumeric works too). If conversion is impossible, tell the user the install hint and abort.
- `.sqlite` / `.db` — `sqlite3 $0 .schema` to see tables, ask the user which table to use (`AskUserQuestion`), then `sqlite3 -header -csv $0 'SELECT * FROM <table>;'`
- Anything else — try `Read` and let the LLM infer the structure

Read enough rows to understand the schema (first ~50 rows is plenty). Do not attempt to read multi-MB files in one shot.

### 3. Map columns to the canonical schema

For each source column, decide what canonical column it corresponds to. Do not invent data:
- If `organizationDomain` is missing but you have an email or website URL, derive the apex domain (e.g. `https://blog.acme.com/foo` → `acme.com`).
- If `organizationWebsiteUrl` is missing, derive `https://` + `organizationDomain`.
- If `websiteUrl` is missing, fall back to `organizationWebsiteUrl`.
- If `overview` is missing, synthesise a one-line description from available fields (industry, name, role) — never leave it blank.
- `matchReason` handling depends on the mode chosen in step 1:
  - **Tenant-only mode**: omit the `matchReason` column entirely from the canonical CSV. Don't ask the user — `/match-prospects` will write fresh per-project reasons later.
  - **Project-linked mode**: if the source has no usable `matchReason`, ask the user once for a default ("Why is this list a fit for this project?") and apply it to every row.
- **`doNotContact` mapping (important)**: if the source has any do-not-contact-like column — common names: `do_not_contact`, `dnc`, `opted_out`, `opt_out`, `unsubscribed`, `unsubscribe`, `is_unsubscribed`, `subscribed=false` — map it to canonical `doNotContact`. Emit `1` for truthy values and leave the cell blank for falsy ones. **Do not silently drop these rows.** They must be imported with the flag set; otherwise `/build-list` may rediscover the same organisation later and the user will outreach to someone who already opted out. Truthy: `1`, `true`, `yes`, `on`, `unsubscribed`, `opted out`. Falsy: `0`, `false`, `no`, `off`, `subscribed`, `active`, blank. If the semantics are ambiguous, ask the user once before mapping.
- If a row has none of email / contactFormUrl / snsAccounts.* — drop it and report it in the per-row error summary.

If the source has columns you cannot place anywhere, ignore them — do not try to widen the schema.

### 4. Confirm with the user before uploading

Show the user:
- the import mode chosen (tenant-only vs linked to project `<name>`)
- the source path and row count detected
- the column mapping you inferred (source column → canonical column)
- if a `doNotContact` column was mapped, how many rows will be flagged DNC vs not
- any rows you are dropping and why

Ask via `AskUserQuestion` whether to proceed. If the user wants tweaks, iterate.

### 5. Write the canonical CSV

Write the canonical CSV to `/tmp/leadace_import_<scope>_<timestamp>.csv` using `Write` (use the project name as `<scope>` for project-linked mode, or `tenant` for tenant-only mode). Use proper CSV quoting:
- Fields containing `,`, `"`, or newlines must be wrapped in `"..."`.
- A literal `"` inside a quoted field is doubled (`""`).

Header row must be exactly the canonical column names (case-sensitive).

### 6. Pick the dedup policy

If `$2` is `skip` or `overwrite`, use it directly. Otherwise ask via `AskUserQuestion`:
- `skip` (default, safer) — existing prospects untouched
- `overwrite` — matched prospects get their fields refreshed (and, in project-linked mode, re-linked to that project)

### 7. Upload

`Read` the canonical CSV file back into a string and call `mcp__plugin_lead-ace_api__import_prospects_from_csv`:

- **Project-linked mode**: pass `projectId: PROJECT_NAME` plus `csvText` and `dedupPolicy`.
- **Tenant-only mode**: omit `projectId` entirely. Pass only `csvText` and `dedupPolicy`. Do not pass an empty string — leave the field out.

### 8. Report

Surface the counts the tool returns:
- `inserted` — newly created
- `overwritten` — existing prospects updated (only with `overwrite`)
- `skipped` — duplicates / `do_not_contact` / plan limit
- `errors` — rows that failed validation

For non-zero `skipped` or `errors`, summarise the top reasons. If the free plan limit was hit, advise the user to upgrade or delete unused projects.

In **tenant-only mode**, finish by suggesting the next step: `Run \`/match-prospects <project-name>\` to surface the imported prospects that fit a specific project's strategy and link them.`

Leave the canonical CSV at `/tmp/leadace_import_*.csv` so the user can re-run with a different policy if needed.
