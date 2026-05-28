-- Enable pgcrypto for symmetric encryption of OAuth refresh tokens.
-- Supabase ships pgcrypto in the `extensions` schema; CREATE EXTENSION is idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- RLS: tenant isolation, identical to other tenant-scoped tables.
ALTER TABLE gmail_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON gmail_credentials
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);
