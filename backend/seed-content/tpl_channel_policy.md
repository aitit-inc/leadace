# Outbound Channel Policy

The default ranking an outbound run uses to pick **one** channel per prospect.
This policy is stable across all projects and is fetched at runtime via
`get_master_document` (slug `tpl_channel_policy`). It is the single source of
truth for the channel ladder — it is not restated in any skill or generated
project document.

## How project configuration interacts with this policy

Two project-level inputs sit on top of this ranking; neither is restated here:

- **Enablement (on/off)** is owned by `project_settings.outboundChannels` and
  is enforced **server-side**: `get_outbound_targets` only returns prospects
  reachable on an enabled channel. Do not re-derive enablement — the candidate
  list is already filtered. (If every channel is disabled, the run is paused
  upstream and returns no targets.)
- **Ordering preference** is owned by the optional "Sales Channels" section of
  `SALES_STRATEGY.md`. When present, it overrides the order below **among the
  channels that survive enablement**. When absent, use the ranking below as-is.

## Channel ranking

Rank the channels a prospect is actually reachable on, then take the highest.
One channel per prospect — never chain channels.

1. **Personal email** — `email` is set AND looks like a named address
   (`first.last@`, `flast@`, `f.last@`, `first@`, etc.), not a department or
   role mailbox.
2. **LinkedIn DM** — `snsAccounts.linkedin` is set. Skip this rung if the
   prospect is not a 1st-degree connection (the browser flow surfaces this).
3. **Department email** — `email` is set and starts with a department/role
   prefix like `sales@`, `bd@`, `partnerships@`, `recruiting@`.
4. **Generic email** — `email` is set and starts with `info@`, `contact@`,
   `support@`, `hello@`, `pr@`. **Demoted but never excluded** — for many
   small companies it is the only reachable address. Its lower reply rate is
   reflected in priority, not in eligibility.
5. **Contact form** — `contactFormUrl` is set.
6. **X / Twitter DM** — `snsAccounts.x` is set. Lowest rung: reach depends on
   the recipient's DM settings.

If only one rung yields a valid channel for the prospect, use it.

## Address classification

- **Named (personal)**: the local part encodes a human name — `jdoe@`,
  `j.doe@`, `jane.doe@`, `jane@`. Highest intent, highest reply rate.
- **Department / role**: a function, not a person — `sales@`, `bd@`,
  `recruiting@`, `partnerships@`. Mid-funnel.
- **Generic / catch-all**: `info@`, `contact@`, `support@`, `hello@`, `pr@`.
  Lowest reply rate; demoted, not excluded.
