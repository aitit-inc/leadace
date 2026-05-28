---
name: setup-cron
description: "Use when the user asks to schedule daily-cycle, set up cron, or run daily-cycle every day. Installs an OS-level schedule (macOS LaunchAgent / Windows Task / Linux cron) for `/daily-cycle PROJECT`. Also covers /loop and /schedule alternatives."
argument-hint: "[project-name]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - mcp__plugin_lead-ace_api__list_projects
---

# Setup-cron - Schedule Daily Automation

A skill that wires `/daily-cycle` into the user's OS scheduler so it runs every day without manual invocation. The skill is **idempotent**: re-running it replaces any existing LeadAce schedule entry.

The skill writes one of:
- macOS LaunchAgent at `~/Library/LaunchAgents/ai.leadace.daily-cycle.plist`
- Windows scheduled task named `LeadAceDailyCycle`
- Linux user crontab line tagged `# leadace-daily-cycle`

Or, if the user prefers in-Claude-Code scheduling, it explains how to use the plugin's existing `/loop` skill or Claude Code's built-in `/schedule` (Remote Trigger).

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Prerequisites

- The user has already run `/setup` and has at least one project. If not, abort and ask them to run `/setup` first.
- The `claude` CLI is on `PATH` (required for OS-level scheduling). The skill verifies this with `which claude`.
- The user has an active Claude Code session with a valid LeadAce MCP OAuth token. **Headless `claude` invocations cannot complete OAuth interactively** — if the token expires (currently every 30 days, sliding), the next scheduled run fails until the user signs in again.

## Steps

### 1. Pick the project

If `$0` is given, use it. Otherwise call `mcp__plugin_lead-ace_api__list_projects` and:
- If exactly one project exists, use it.
- If multiple exist, ask via `AskUserQuestion`.
- If none, abort: "No projects yet. Run `/setup <project-name>` first."

Hold the chosen name in `PROJECT_NAME`.

### 2. Pick the scheduling method

Use `AskUserQuestion` with these options (omit options that don't apply to the user's OS — detect with `uname -s`: `Darwin` -> mac, `Linux` -> linux, otherwise -> windows):

- `macOS LaunchAgent` — runs even when no Terminal is open, as long as the user is logged in (mac only)
- `Windows Task Scheduler` — runs on a fixed schedule (windows only)
- `Linux cron` — user crontab entry (linux only)
- `/loop (in-Claude-Code)` — runs only while a Claude Code session has `/loop` active
- `/schedule (in-Claude-Code, Remote Trigger)` — runs in the cloud regardless of the local machine, OS-independent

If the user picks `/loop` or `/schedule`, skip steps 3-5 and jump to "In-Claude-Code alternative" below.

### 3. Pick run time

Ask in plain text (do not use AskUserQuestion for free-form): "What local time should `/daily-cycle` run? (24h `HH:MM`, default `09:00`)". Validate the format; default to `09:00` if blank.

### 4. Verify `claude` CLI

```bash
which claude || echo "MISSING"
```

If `MISSING`, abort: "The `claude` CLI is not on PATH. OS-level scheduling needs it. Install Claude Code (https://claude.com/claude-code) or pick `/loop` / `/schedule` instead."

Capture the absolute path; LaunchAgent / cron / schtasks all need an absolute path because they don't inherit a shell PATH.

### 5. Install the scheduler entry

Generate the config for the chosen OS (templates below). Show the user the exact file/command that will be installed and ask `AskUserQuestion`: "Install now? (yes / no, just print)". On `no`, print the install commands and stop. On `yes`, run the install commands shown for that OS.

After installation, verify:
- macOS: `launchctl list | grep ai.leadace.daily-cycle` returns a row
- Linux: `crontab -l | grep leadace-daily-cycle` returns the line
- Windows: `schtasks /Query /TN LeadAceDailyCycle` returns the task

If verification fails, surface the raw output and stop without claiming success.

### 6. Report

Print:
- The schedule (`HH:MM` daily, OS, project name)
- The file/task the skill installed and how to inspect/remove it
- A reminder: "OAuth token currently expires after ~30 days of inactivity. If the scheduled run starts failing, run `/setup` again from an interactive Claude Code session to re-sign in."

---

## Templates

Use the user's local timezone (whatever `date +%Z` reports). Substitute `<HH>`, `<MM>`, `<PROJECT_NAME>`, `<CLAUDE_PATH>` (absolute path from `which claude`), and `<HOME>` (`echo $HOME`).

### macOS LaunchAgent

Path: `<HOME>/Library/LaunchAgents/ai.leadace.daily-cycle.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.leadace.daily-cycle</string>
  <key>ProgramArguments</key>
  <array>
    <string><CLAUDE_PATH></string>
    <string>--print</string>
    <string>/daily-cycle <PROJECT_NAME></string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer><HH></integer>
    <key>Minute</key><integer><MM></integer>
  </dict>
  <key>StandardOutPath</key>
  <string><HOME>/Library/Logs/leadace-daily-cycle.log</string>
  <key>StandardErrorPath</key>
  <string><HOME>/Library/Logs/leadace-daily-cycle.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Install:

```bash
mkdir -p ~/Library/LaunchAgents
# Write the plist with Write tool, not heredoc, so we don't tangle with shell escaping
launchctl unload ~/Library/LaunchAgents/ai.leadace.daily-cycle.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/ai.leadace.daily-cycle.plist
```

Inspect/remove later:
- `launchctl list | grep ai.leadace.daily-cycle`
- `launchctl unload ~/Library/LaunchAgents/ai.leadace.daily-cycle.plist && rm ~/Library/LaunchAgents/ai.leadace.daily-cycle.plist`

### Linux cron

Add this line to the user's crontab (preserve any existing lines):

```
<MM> <HH> * * * <CLAUDE_PATH> --print "/daily-cycle <PROJECT_NAME>" >> <HOME>/.leadace-daily-cycle.log 2>&1  # leadace-daily-cycle
```

Install (replace any existing leadace-daily-cycle line):

```bash
( crontab -l 2>/dev/null | grep -v "# leadace-daily-cycle" ; echo '<MM> <HH> * * * <CLAUDE_PATH> --print "/daily-cycle <PROJECT_NAME>" >> <HOME>/.leadace-daily-cycle.log 2>&1  # leadace-daily-cycle' ) | crontab -
```

Inspect/remove later:
- `crontab -l | grep leadace-daily-cycle`
- `crontab -l | grep -v "# leadace-daily-cycle" | crontab -`

### Windows Task Scheduler

Run from PowerShell or cmd. The user must already have `claude` on PATH for the task — verify by running `claude --version` in the same shell.

```powershell
schtasks /Create /TN LeadAceDailyCycle /SC DAILY /ST <HH>:<MM> /TR "\"<CLAUDE_PATH>\" --print \"/daily-cycle <PROJECT_NAME>\"" /F
```

Inspect/remove later:
- `schtasks /Query /TN LeadAceDailyCycle`
- `schtasks /Delete /TN LeadAceDailyCycle /F`

---

## In-Claude-Code alternative

If the user picked `/loop` or `/schedule`:

- **`/loop`**: tell the user to start a Claude Code session and run `/loop 24h /daily-cycle <PROJECT_NAME>`. The loop continues only while that session stays open. Best when the user always has Claude Code running anyway.
- **`/schedule`**: tell the user to run `/schedule` (Remote Trigger) and follow the prompt to create a daily routine that runs `/daily-cycle <PROJECT_NAME>` at the desired time. Runs in the cloud, OS-independent, survives machine sleep.

Print the exact command they should run, then stop. The skill does not auto-install in-Claude-Code alternatives — those are user-driven.

---

## Notes

- The skill never tries to bypass safety prompts in scheduled runs. `claude --print` runs the skill non-interactively and the LLM will refuse irreversible actions if it would normally prompt. The user's plan-tier rate limits and `/setup` env_status still apply at run time.
- If the user is on a self-host backend, the schedule does not need any change — `claude` reads `LEADACE_MCP_URL` from the user's existing Claude Code config the same way as the interactive session.
