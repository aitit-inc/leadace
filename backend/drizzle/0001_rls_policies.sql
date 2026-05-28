-- Create application role for RLS enforcement
-- This role does NOT bypass RLS (unlike the postgres superuser).
-- Route handlers run as this role inside a transaction with app.tenant_id set.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN;
  END IF;
END $$;--> statement-breakpoint

-- Grant app_rls membership to the current user (usually `postgres`).
-- On managed Postgres like Supabase, `postgres` is NOT a superuser and cannot
-- `SET ROLE app_rls` unless explicitly made a member. On local dev Postgres
-- where `postgres` is superuser, this grant is a no-op.
DO $$ BEGIN
  EXECUTE 'GRANT app_rls TO ' || current_user;
END $$;--> statement-breakpoint

-- Grant table and sequence access to app_rls
GRANT USAGE ON SCHEMA public TO app_rls;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rls;--> statement-breakpoint

-- Enable RLS on all tenant-scoped tables
-- RLS does NOT apply to the table owner (postgres superuser) by default,
-- so auth middleware and stripe webhook (which run as postgres) are unaffected.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_prospects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE outreach_logs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS policies: tenant isolation via current_setting('app.tenant_id')
-- The middleware sets this value with SET LOCAL inside a transaction.

CREATE POLICY tenant_isolation ON tenants
  FOR ALL TO app_rls
  USING (id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON tenant_members
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON tenant_plans
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON projects
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON organizations
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON prospects
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON project_prospects
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON outreach_logs
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON responses
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON project_documents
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON evaluations
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);
