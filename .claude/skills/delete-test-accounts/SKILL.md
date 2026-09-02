---
name: delete-test-accounts
description: "Delete test accounts (Supabase Auth user + owned tenant and every tenant-scoped row) from a LeadAce database with backend/scripts/delete-accounts.ts. Triggers: 'delete test accounts', 'テストアカウント削除', 'アカウントを本番から削除', cleaning up signup-test users given by auth UUID or email."
---

# Delete test accounts

`backend/scripts/delete-accounts.ts` removes, per target, the `tenants` row (every tenant-scoped table cascades from it) and the `auth.users` row (Supabase's auth tables cascade from it). Targets are auth user UUIDs or emails. Default is a dry-run inventory; `--apply` deletes — and only when every target is deletable: one `BLOCKED` or `not found` target aborts the whole run with nothing deleted, so a typo cannot produce a partial cleanup.

A target is `BLOCKED` when its membership is not `owner`, when the tenant has other members, or when the tenant still records a Stripe subscription and no `STRIPE_SECRET_KEY` is available. With `STRIPE_SECRET_KEY` in the env file the subscription is canceled before the delete (same call and tolerance as the in-app `DELETE /me/account`).

## Procedure (production)

Production requires user approval for every DB operation, dry-run included (`docs/tasks.local.md` §prod DB). Two approvals, one per command:

1. Inventory (read only) — present the command, get OK, run:
   ```bash
   cd backend && npx tsx scripts/delete-accounts.ts --env-file=.env.production <uuid|email>...
   ```
   Show the output verbatim: email, tenant id / name, plan, role / member count, Stripe ids, first MCP connection, row counts. Confirm every target is the intended test account (email, created date). Stop if a target is `BLOCKED` or looks like a real user; `--apply` refuses to run until the list is clean.
2. Delete (write) — only after the user confirms the inventory:
   ```bash
   cd backend && npx tsx scripts/delete-accounts.ts --env-file=.env.production <uuid|email>... --apply
   ```
   Report the `deleted <target>: tenants=N, auth.users=N` lines.

Local stack: omit `--env-file` (falls back to `backend/.dev.vars`).

## Not covered

- Stripe without `STRIPE_SECRET_KEY`: a tenant that records a `stripe_subscription_id` is refused. A `free` plan does not prove the subscription is dead — the webhook keeps the id for statuses that can still bill (`incomplete`, `past_due`). Put the key in the env file, or have the user delete through the app.
- Stripe customer objects are left in place; only the subscription is canceled.
- MCP OAuth tokens in KV (`MCP_OAUTH_STORE`) expire on their own (≤30 days) and Google OAuth grants are not revoked — same as the in-app deletion.
- `account_deletion_surveys` is not written: ops cleanup is not user churn.
