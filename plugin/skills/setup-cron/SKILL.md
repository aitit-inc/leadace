---
name: setup-cron
description: "Use when the user asks to schedule daily-cycle, set up cron, or run daily-cycle every day. Sets up a Claude Cowork scheduled task (default) or a Claude Code Desktop task, covers /loop, and installs an OS schedule only as a last resort."
argument-hint: "[project-name]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - mcp__plugin_leadace_leadace__list_projects
---

# Setup-cron - Schedule Daily Automation

Sets up an unattended daily run of `/daily-cycle <project>`. One schedule per project; schedules for different projects coexist.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there.

## Prerequisites

- At least one project exists. None -> "Run `/leadace <your-homepage-URL>` first."

## Confirm with the user

Use `AskUserQuestion` for enumerable choices, plain text for free-form input.

1. **Project**: `$0` if given; else `list_projects` — exactly one -> use it, several -> ask. `<PROJECT_SLUG>` = the project name lowercased, every character outside `[a-z0-9]` replaced by `-` (collapse runs, trim leading/trailing `-`).
2. **Method**, offered in this order; state what each can run before the user picks:
   - **Claude Cowork scheduled task** — default. Runs in the cloud with no machine on; browser channels need the Claude Desktop app open at run time.
   - **Claude Code Desktop scheduled task** — runs on the user's machine while Claude Desktop is open and the computer is awake, with whatever local toolchain and browser MCP the user has configured (`/leadace` shows the live capability summary). A Claude Code *cloud routine* also exists, but it must be attached to a GitHub repository (cloned on every run; it uses the skills committed there) although LeadAce needs no repository — mention it, do not recommend it; it is unverified with LeadAce.
   - `/loop 24h /daily-cycle <PROJECT_NAME>` — runs only while that session stays open and expires after 7 days. Print it and stop.
   - **OS scheduler** (LaunchAgent / cron / Task Scheduler) — last resort, for a machine without the Desktop app such as a headless server. Offer it only when the others do not fit.
3. **Schedule**: time (24h `HH:MM`, local timezone, default `09:00`) and frequency (every day / weekdays only).

## Claude Cowork — scheduled task

Nothing is installed from here; walk the user through the UI:

1. **Scheduled** (sidebar) -> new task, or `/schedule` in any Cowork session. Name it `LeadAce daily-cycle <PROJECT_NAME>`; if one already exists for this project, edit it instead of adding another.
2. Prompt: `/daily-cycle <PROJECT_NAME>` — append a count to override the outbound target (`/daily-cycle <PROJECT_NAME> 5`).
3. Frequency: the chosen time, every day or weekdays.
4. Permissions: **auto-approve** — anything left on "ask" aborts the run.
5. Settings -> Capabilities -> Code execution -> Allow network egress: **All domains**. With the default (package managers only) every page fetch fails and only check-responses, evaluate, and email sending complete.
6. If the project uses contact forms, SNS, or platform channels: keep Claude Desktop open at the scheduled time, and pick its default browser beforehand — a scheduled run cannot answer the browser chooser, and a run that gets no answer has no browser automation. Forms run on the built-in Claude browser or Claude in Chrome; SNS DMs and platform channels need Claude in Chrome's logged-in profile.

The task runs in the cloud; the user's browser is reachable while the Claude Desktop app is open on their machine.

- Runs without the machine: check-responses (email replies; SNS and platform replies stay unconfirmed), evaluate, email outbound, build-list (slower and thinner than a local run — the cloud egress IP is refused by some sources).
- Needs the Desktop app open at run time: contact forms, SNS DMs, platform outreach. Without the Desktop app there is no browser automation: Claude in Chrome is unreachable, and a headless browser inside the sandbox cannot complete TLS through the egress relay. A machine that cannot stay open at that time: use the Claude Code Desktop task.

Report: the prompt, the schedule, the egress setting, what runs without the machine and which channels need the Desktop app open; ask the user to confirm the task shows under Scheduled.

## Claude Code Desktop — scheduled task

Nothing is installed from here; walk the user through the UI: **Code** tab -> **Routines** -> **New routine** -> **Local**. Name: `leadace-daily-cycle-<PROJECT_SLUG>`; if that task already exists, edit it instead of creating another.

- Instructions: `/daily-cycle <PROJECT_NAME>` (a count may follow). Working folder = the folder the user runs LeadAce from — plugins, MCP servers, and permission rules are discovered from it. Isolated worktree: off.
- Permission mode: keep the default, never a bypass-all mode. After saving, **Run now** once and answer "always allow" for each prompt; later runs auto-approve the same tools instead of stalling.
- Schedule: Daily or Weekdays at the chosen time.
- Runs only while Claude Desktop is open and the computer is awake (Settings -> Desktop app -> General -> **Keep computer awake**; a closed lid still sleeps). After missed runs, exactly one catch-up run starts on wake.

Report: the task name, schedule, folder, and the awake requirement.

## OS scheduler — last resort

Installs an OS-scheduler entry that runs `/daily-cycle <project>` headless; re-running for the same project replaces its entry. Advanced: absolute paths, stored permission rules, and OAuth expiry are the user's to maintain.

Check before installing:

- `claude` CLI on PATH (`which claude`; capture the absolute path). Missing -> stop and offer the other methods.
- Headless runs cannot answer permission prompts: any tool without a stored allow rule is denied, and repeated denials abort the run. The user should have run `/daily-cycle` interactively at least once from this directory, answering "always allow" for its tools; if they haven't, warn that scheduled runs may abort until they do. Never compensate with permission-bypass flags — denying un-allowed tools is the intended fail-safe.
- The MCP OAuth token is reused from interactive sessions and expires after ~30 days of inactivity; scheduled runs then fail until the user signs in interactively again.

Then: **Model** — default = omit `--model` so the run uses the user's configured model; add `--model <name>` only if the user names one. Show the exact file/command about to be installed and ask "Install now / just print". On print: output the commands and stop.

### Invariants of the scheduled command

Every template below must:

- run `<CLAUDE_PATH> -p "/daily-cycle <PROJECT_NAME>" --permission-mode dontAsk` (plus `--model` if chosen), with `<CLAUDE_PATH>` absolute — schedulers don't inherit shell PATH
- set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=10800000` (3 h) — daily-cycle runs its phases as sub-agents, and headless mode otherwise cuts sub-agent waits off at 10 minutes
- start in the current session's working directory (`<WORKDIR>` = `pwd`) — plugins, MCP servers, and permission rules are discovered from the cwd, so a different start directory can silently lose the LeadAce plugin
- embed `<PROJECT_SLUG>` in every named artifact — scheduler label/task name, plist/wrapper file, crontab tag, log files — so schedules for several projects coexist and replace/remove operations touch only their own project
- append stdout/stderr to a log file in the user's home

### Templates

Substitute `<HH>`, `<MM>`, `<PROJECT_NAME>`, `<PROJECT_SLUG>`, `<CLAUDE_PATH>`, `<WORKDIR>`, `<HOME>`.

#### macOS — `<HOME>/Library/LaunchAgents/ai.leadace.daily-cycle.<PROJECT_SLUG>.plist`

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

#### Linux — user crontab

```
<MM> <HH> * * * cd <WORKDIR> && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=10800000 <CLAUDE_PATH> -p "/daily-cycle <PROJECT_NAME>" --permission-mode dontAsk >> <HOME>/.leadace-daily-cycle.<PROJECT_SLUG>.log 2>&1  # leadace-daily-cycle-<PROJECT_SLUG>
```

Weekdays only: `<MM> <HH> * * 1-5`. Install by replacing any existing line with the same tag:

```bash
( crontab -l 2>/dev/null | grep -v "# leadace-daily-cycle-<PROJECT_SLUG>" ; echo '<the line above>' ) | crontab -
```

#### Windows — Task Scheduler

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

### Verify, then report

Verification (on failure: show the raw output and stop without claiming success):

- macOS: `launchctl list | grep ai.leadace.daily-cycle.<PROJECT_SLUG>`
- Linux: `crontab -l | grep leadace-daily-cycle-<PROJECT_SLUG>`
- Windows: `schtasks /Query /TN LeadAceDailyCycle-<PROJECT_SLUG>`

Report: the schedule (time, frequency, project), the installed file/task, the log path, how to remove it (macOS: `launchctl unload <plist> && rm <plist>` / Linux: `crontab -l | grep -v "# leadace-daily-cycle-<PROJECT_SLUG>" | crontab -` / Windows: `schtasks /Delete /TN LeadAceDailyCycle-<PROJECT_SLUG> /F`), and the ~30-day OAuth reminder.
