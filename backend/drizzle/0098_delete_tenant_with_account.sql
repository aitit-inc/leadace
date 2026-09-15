-- The mirror of 0097: the tenant is deleted in the same transaction as the
-- Supabase user, whoever deletes the row (the app, the Admin API, the
-- dashboard), so an account and its tenant never outlive each other. Every
-- tenant-scoped table cascades from tenants.
CREATE OR REPLACE FUNCTION public.delete_tenant_of_deleted_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.tenants t
  USING public.tenant_members m
  WHERE m.tenant_id = t.id AND m.user_id = OLD.id::text AND m.role = 'owner';
  RETURN OLD;
END;
$$;--> statement-breakpoint

-- auth.users exists only under Supabase Auth; a vanilla Postgres skips this.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    CREATE TRIGGER on_auth_user_deleted_tenant
      AFTER DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.delete_tenant_of_deleted_user();
  END IF;
END $$;
