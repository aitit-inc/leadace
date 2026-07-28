# LeadAce

Autonomous lead generation plugin for Claude Code. Builds prospect lists, runs
outbound outreach, and iterates on strategy — all hands-free.

> **Two ways to run it.** Use the hosted service at [app.leadace.ai](https://app.leadace.ai)
> (Free tier — 5 outreach/day, paid plans from $29/mo), or self-host the
> backend on your own Cloudflare + Supabase — see
> [docs/self-host.md](../docs/self-host.md). The plugin is the same in either
> case; set `LEADACE_MCP_URL` to point it at your own MCP server.

## Prerequisites

- Claude Code
- A LeadAce account (sign up at https://app.leadace.ai — Free tier, no card)
- A connected Gmail account — for sending email (granted when you sign in with Google, or via the "Connect Gmail" banner in the web app)
- Gmail MCP (claude.ai built-in) — for checking email replies
- claude-in-chrome MCP — for form submission and SNS DMs (forms can alternatively use any other browser-automation MCP you configure yourself, e.g. Playwright; SNS DMs require claude-in-chrome)

## Installation

One line in your terminal:

```bash
claude plugin marketplace add aitit-inc/leadace && claude plugin install leadace@leadace
```

Or, from inside a running Claude Code session:

```
/plugin marketplace add aitit-inc/leadace
/plugin install leadace@leadace
```

To update later:

```
/plugin marketplace update
/plugin update leadace@leadace
```

## Sign in

The first time the plugin calls a LeadAce tool, Claude Code opens a browser
window to the LeadAce MCP server (`https://mcp.leadace.ai` by default, or your
`LEADACE_MCP_URL`) for Google sign-in with the same Google account as the web
app. The token is cached locally for subsequent runs.

### Self-hosting

Override the MCP URL by exporting `LEADACE_MCP_URL` before launching Claude
Code:

```bash
export LEADACE_MCP_URL=http://localhost:8788/mcp
```

The default `https://mcp.leadace.ai/mcp` is used when this variable is unset.

### Troubleshooting

- **`MCP server unreachable`** — verify network access to
  `https://mcp.leadace.ai` (or your self-hosted URL). For self-hosting, also
  check that `LEADACE_MCP_URL` is exported in the shell that launched Claude
  Code.
- **Browser asks to sign in repeatedly** — the cached token expired. Re-running
  any LeadAce command kicks off a fresh OAuth flow.
- **`401 Unauthorized` from a tool** — the Supabase session expired. Sign out
  of `app.leadace.ai`, sign in again, then re-authorize when the plugin
  prompts.

## Commands

Most commands take your project name as the first argument (chosen during `/leadace` onboarding); `/leadace` itself takes a free-form question or homepage URL.

| Command | Purpose |
|---|---|
| **Setup** | |
| `/leadace` | Entry point — onboarding, environment setup / re-check, strategy authoring, overview, and routing |
| **Add prospects** (pick one) | |
| `/build-list <name>` | Web search for new prospects |
| `/import-prospects <name>` | Load CSV / Excel / SQLite |
| `/match-prospects <name>` | Reuse prospects already in your tenant |
| **Sales loop** | |
| `/outbound <name>` | Send via email, contact forms, SNS DMs |
| `/check-responses <name>` | Collect Gmail + SNS replies → DB |
| `/evaluate <name>` | PDCA — auto-improve strategy and surface tactical rejection signals |
| **Reflection** | |
| `/check-feedback <name>` | Surface PMF signals from rejection feedback (feature gaps, competitor presence) |
| **Automation** | |
| `/daily-cycle <name> [count]` | One-shot bundle: check-responses → evaluate → outbound + build-list |
| `/setup-cron <name>` | Schedule `/daily-cycle` on the OS (LaunchAgent / Task / cron) |
| **Maintenance** | |
| `/delete-project <name>` | Permanently delete a project and all its data |

Projects, prospects, outreach logs, and strategy documents live in the cloud —
there are no local files to manage. Review everything in the web app at
https://app.leadace.ai.

## License

Modified Apache 2.0 (no multi-tenant SaaS, frontend logo preserved), by
SurpassOne Inc. See [LICENSE](../../LICENSE).

- **Hosted (cloud) free tier:** 1 project, 500 prospects, 5 outreach
  actions per day (100 lifetime cap).
- **Paid plans** start at $29/month. Manage your subscription from the web app.
- **Self-host:** unlimited tier by default. See
  [docs/self-host.md](../../docs/self-host.md).

## Development

The plugin lives at `plugin/` in the [aitit-inc/leadace](https://github.com/aitit-inc/leadace)
monorepo. For repo layout, local dev, and self-hosting, see the top-level
[README.md](../README.md), [CLAUDE.md](../CLAUDE.md), and
[docs/self-host.md](../docs/self-host.md).

```
plugin/
├── .claude-plugin/plugin.json   # Manifest
├── .mcp.json                    # MCP server config (uses LEADACE_MCP_URL)
├── skills/                      # Slash commands (each directory contains SKILL.md)
├── scripts/fetch_url.py         # Local web fetch helper
└── references/                  # Shared reference docs
```

- Each skill's behavior is defined in `skills/<name>/SKILL.md`
- Use `${CLAUDE_PLUGIN_ROOT}` to reference the plugin root from scripts
- Domain knowledge (templates, guidelines, frameworks) lives in the cloud as
  `master_documents` and is fetched at runtime via `get_master_document`
- Project-specific skill authoring conventions (SKILL.md line limits, sub-agent
  prompt wording for irreversible actions) live in
  [.claude/rules/plugin-development.md](../.claude/rules/plugin-development.md),
  auto-loaded when files under `plugin/` are touched
