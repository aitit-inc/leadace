---
name: setup-cron
description: "Use when the user asks to schedule daily-cycle, set up cron, or run daily-cycle every day. Installs an OS-level schedule (macOS LaunchAgent / Windows Task / Linux cron) for `/daily-cycle PROJECT`. Also covers the in-Claude-Code /loop alternative."
argument-hint: "[project-name]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - mcp__plugin_leadace_api__list_projects
---

# Setup-cron - Schedule Daily Automation

Installs an OS-scheduler entry that runs `/daily-cycle <project>` headless on a daily schedule. One entry per project: re-running for the same project replaces its entry; entries for different projects coexist.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there.

## Prerequisites — verify, and abort with the fix if missing

- At least one project exists. None -> "Run `/leadace <your-homepage-URL>` first."
- `claude` CLI on PATH (`which claude`; capture the absolute path). Missing -> offer the `/loop` alternative.
- Headless runs cannot answer permission prompts: any tool without a stored allow rule is denied, and repeated denials abort the run. The user should have run `/daily-cycle` interactively at least once from this directory, answering "always allow" for its tools; if they haven't, warn that scheduled runs may abort until they do. Never compensate with permission-bypass flags — denying un-allowed tools is the intended fail-safe.
- The MCP OAuth token is reused from interactive sessions and expires after ~30 days of inactivity; scheduled runs then fail until the user signs in interactively again.

## Confirm with the user

Use `AskUserQuestion` for enumerable choices, plain text for free-form input.

1. **Project**: `$0` if given; else `list_projects` — exactly one -> use it, several -> ask.
2. **Method**: the OS scheduler matching `uname -s`, or in-Claude-Code `/loop`. If `/loop`: print `/loop 24h /daily-cycle <PROJECT_NAME>` (runs only while that session stays open) and stop. `/schedule` cloud routines cannot run LeadAce yet — plugin skills and the MCP server are not available in cloud runs.
3. **Schedule**: time (24h `HH:MM`, local timezone, default `09:00`) and frequency (every day / weekdays only).
4. **Model**: default = omit `--model` so the run uses the user's configured model; add `--model <name>` only if the user names one.
5. Show the exact file/command about to be installed and ask "Install now / just print". On print: output the commands and stop.

## Invariants of the scheduled command

Every template below must:

- run `<CLAUDE_PATH> -p "/daily-cycle <PROJECT_NAME>" --permission-mode dontAsk` (plus `--model` if chosen), with `<CLAUDE_PATH>` absolute — schedulers don't inherit shell PATH
- set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=10800000` (3 h) — daily-cycle runs its phases as sub-agents, and headless mode otherwise cuts sub-agent waits off at 10 minutes
- start in the current session's working directory (`<WORKDIR>` = `pwd`) — plugins, MCP servers, and permission rules are discovered from the cwd, so a different start directory can silently lose the LeadAce plugin
- carry `LEADACE_MCP_URL` into the entry's environment if it is set in the current session (self-host) — schedulers don't read shell rc files. Place it alongside `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (plist `EnvironmentVariables` / cron line prefix / `.cmd` `set`); omit entirely when unset
- embed `<PROJECT_SLUG>` in every named artifact — scheduler label/task name, plist/wrapper file, crontab tag, log files — so schedules for several projects coexist and replace/remove operations touch only their own project
- append stdout/stderr to a log file in the user's home

## Templates

Substitute `<HH>`, `<MM>`, `<PROJECT_NAME>`, `<PROJECT_SLUG>`, `<CLAUDE_PATH>`, `<WORKDIR>`, `<HOME>`.
`<PROJECT_SLUG>` = the project name lowercased, with every character outside `[a-z0-9]` replaced by `-` (collapse runs, trim leading/trailing `-`).

### macOS — `<HOME>/Library/LaunchAgents/ai.leadace.daily-cycle.<PROJECT_SLUG>.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.leadace.daily-cycle.<PROJECT_SLUG></string>
  <key>ProgramArguments</key>
  <array>
    <string><CLAUDE_PATH></string>
    <string>-p</string>
    <string>/daily-cycle <PROJECT_NAME></string>
    <string>--permission-mode</string>
    <string>dontAsk</string>
  </array>
  <key>WorkingDirectory</key>
  <string><WORKDIR></string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer><HH></integer>
    <key>Minute</key><integer><MM></integer>
  </dict>
  <key>StandardOutPath</key>
  <string><HOME>/Library/Logs/leadace-daily-cycle.<PROJECT_SLUG>.log</string>
  <key>StandardErrorPath</key>
  <string><HOME>/Library/Logs/leadace-daily-cycle.<PROJECT_SLUG>.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS</key>
    <string>10800000</string>
  </dict>
</dict>
</plist>
```

Weekdays only: make `StartCalendarInterval` an array of five dicts, each also containing `<key>Weekday</key><integer>N</integer>` for N in 1-5.

Write the plist with the Write tool (heredoc escaping is error-prone), then install:

```bash
mkdir -p ~/Library/LaunchAgents
launchctl unload ~/Library/LaunchAgents/ai.leadace.daily-cycle.<PROJECT_SLUG>.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/ai.leadace.daily-cycle.<PROJECT_SLUG>.plist
```

### Linux — user crontab

```
<MM> <HH> * * * cd <WORKDIR> && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=10800000 <CLAUDE_PATH> -p "/daily-cycle <PROJECT_NAME>" --permission-mode dontAsk >> <HOME>/.leadace-daily-cycle.<PROJECT_SLUG>.log 2>&1  # leadace-daily-cycle-<PROJECT_SLUG>
```

Weekdays only: `<MM> <HH> * * 1-5`. Install by replacing any existing line with the same tag:

```bash
( crontab -l 2>/dev/null | grep -v "# leadace-daily-cycle-<PROJECT_SLUG>" ; echo '<the line above>' ) | crontab -
```

### Windows — Task Scheduler

Write `<HOME>\leadace-daily-cycle-<PROJECT_SLUG>.cmd` (a wrapper file sidesteps `/TR` quoting limits):

```bat
@echo off
cd /d <WORKDIR>
set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=10800000
"<CLAUDE_PATH>" -p "/daily-cycle <PROJECT_NAME>" --permission-mode dontAsk >> "%USERPROFILE%\leadace-daily-cycle-<PROJECT_SLUG>.log" 2>&1
```

```powershell
schtasks /Create /TN LeadAceDailyCycle-<PROJECT_SLUG> /SC DAILY /ST <HH>:<MM> /TR "\"<HOME>\leadace-daily-cycle-<PROJECT_SLUG>.cmd\"" /F
```

Weekdays only: `/SC WEEKLY /D MON,TUE,WED,THU,FRI`.

## Verify, then report

Verification (on failure: show the raw output and stop without claiming success):

- macOS: `launchctl list | grep ai.leadace.daily-cycle.<PROJECT_SLUG>`
- Linux: `crontab -l | grep leadace-daily-cycle-<PROJECT_SLUG>`
- Windows: `schtasks /Query /TN LeadAceDailyCycle-<PROJECT_SLUG>`

Report: the schedule (time, frequency, project), the installed file/task, the log path, how to remove it (macOS: `launchctl unload <plist> && rm <plist>` / Linux: `crontab -l | grep -v "# leadace-daily-cycle-<PROJECT_SLUG>" | crontab -` / Windows: `schtasks /Delete /TN LeadAceDailyCycle-<PROJECT_SLUG> /F`), and the ~30-day OAuth reminder from Prerequisites.
