# Supabase Email Templates

English-language HTML templates for the transactional emails Supabase Auth sends to LeadAce users. These are the source of truth; production Supabase is updated by pasting them into the Dashboard.

## Files

| File | Supabase type | Subject line |
|---|---|---|
| `confirm-signup.html` | Confirm signup | `Confirm your LeadAce account` |
| `reset-password.html` | Reset password | `Reset your LeadAce password` |
| `magic-link.html` | Magic link | `Your LeadAce sign-in link` |
| `change-email.html` | Change email address | `Confirm your new email` |

Not templated (current product doesn't use): `invite`.

## Updating production

For the hosted Supabase project (`chaxrcdtxngoyqvtoyem`):

1. [Dashboard → Authentication → Email Templates](https://supabase.com/dashboard/project/chaxrcdtxngoyqvtoyem/auth/templates)
2. For each template above, set the subject line in the table, then paste the HTML body.
3. Save.

There's no API sync — the Dashboard is authoritative for production. Keep this directory in sync by hand when the templates change.

## Local dev

`supabase/config.toml` points each template at the file in this directory via `[auth.email.template.*].content_path`. Running `supabase start` picks them up automatically.

## Template variables

All templates can use these Go-template variables (Supabase-provided):

| Variable | Available in | Value |
|---|---|---|
| `{{ .ConfirmationURL }}` | all | Full confirmation/action URL |
| `{{ .Email }}` | all | User's current email |
| `{{ .NewEmail }}` | `change-email` | User's requested new email |
| `{{ .Token }}` | all | 6-digit OTP |
| `{{ .SiteURL }}` | all | Site URL from project settings |

See [Supabase docs: Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates) for the full list.
