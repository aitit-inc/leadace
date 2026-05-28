# Scheduling Services — Notification Sender Domains

This document maps known scheduling services to the apex domain(s) they use for booking notification emails. Used by `/check-results` to search Gmail for booking notifications, and by `/strategy` to auto-fill the sender domain when the user names a service.

## Why domains, not full email addresses

Local-parts (`no-reply@`, `notifications@`, `do-not-reply@`, `booking@`, …) are chosen by the service and can change without notice. Domains are tied to the brand and almost never change. Matching on domain is robust against local-part rotation, and the existing content-match step (prospect name / email in body) filters out unrelated mail from the same domain.

## Known services

| Service | Notification domain(s) | Region | Notes |
|---|---|---|---|
| Calendly | `calendly.com` | Global | |
| Cal.com | `cal.com` | Global | Open-source alternative |
| HubSpot Meetings | `hubspot.com` | Global | HubSpot uses many subdomains; apex catches them all |
| SavvyCal | `savvycal.com` | Global | |
| Microsoft Bookings | `microsoft.com` | Global | Booking notifications are sent from various MS subdomains; apex catches them. May overlap with non-booking MS mail — content match in `/check-results` step 3d filters false positives |
| Chili Piper | `chilipiper.com` | Global, enterprise | |
| Doodle | `doodle.com` | Global | |
| TimeRex | `timerex.net` | Japan | |
| Spir | `spirinc.com` | Japan | |

## How `/check-results` uses this

For each scheduling service the user has configured (in `SALES_STRATEGY.md` Response Definition section, or any service the user later mentions):

1. Look up the apex domain in this list
2. Search Gmail with `from:<domain> newer_than:4d` (substring match catches subdomains)
3. For each hit, verify by matching prospect name / email in the body (existing step 3d logic)

Multiple schedulers in parallel are supported — search each separately.

## How `/strategy` uses this

When the user names a scheduling service in Step 4-9:
1. Look up the service in this list
2. If found, record the canonical domain in `SALES_STRATEGY.md` automatically (no need to ask the user for the sender address)
3. If not found, ask the user for the notification sender domain

## Adding a new service

If you encounter a scheduling service notification from a domain not listed here:
1. Inspect the actual booking confirmation email to identify the sender domain
2. Use the **apex domain** (e.g., `calendly.com`, not `email.calendly.com`) — Gmail's substring search catches subdomains
3. Add a row to the table above
4. Re-seed the master_documents table on prod (`scripts/seed-master-documents.ts`)

## Caveats

- These mappings are best-effort and based on public information. Verify by inspecting an actual booking notification you've received before relying on a specific entry.
- A service may use a separate marketing domain or third-party ESP for notifications (e.g., a service might send via `@bookings.acme.com` instead of `@acme.com`). When found, add the explicit subdomain entry.
- This list intentionally omits local-parts. Do not store `no-reply@calendly.com` etc. — domains are sufficient and more robust.

Last verified: 2026-04-30
