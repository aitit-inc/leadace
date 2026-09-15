-- The tenant is created in the same transaction as the Supabase user, so there
-- is one creator and the auth middleware only reads. SECURITY DEFINER runs the
-- inserts as the migration role, which owns the tenant tables and so bypasses
-- their (not FORCEd) RLS. The id keeps the app's shape, 21 chars of A-Za-z0-9,
-- without an extension.
CREATE OR REPLACE FUNCTION public.create_tenant_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_tenant_id text := left(translate(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'base64'), '+/=', ''), 21);
BEGIN
  INSERT INTO public.tenants (id, name, created_at) VALUES (new_tenant_id, 'My Workspace', now());
  INSERT INTO public.tenant_plans (tenant_id, plan, created_at, updated_at) VALUES (new_tenant_id, 'free', now(), now());
  INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at) VALUES (new_tenant_id, NEW.id::text, 'owner', now());
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- auth.users exists only under Supabase Auth; a vanilla Postgres skips this.
-- The backfill gives every existing account without a tenant one, made the same way.
DO $$
DECLARE
  account_id text;
  new_tenant_id text;
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    CREATE TRIGGER on_auth_user_created_tenant
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.create_tenant_for_new_user();

    FOR account_id IN
      SELECT u.id::text FROM auth.users u
      WHERE NOT EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.user_id = u.id::text)
    LOOP
      new_tenant_id := left(translate(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'base64'), '+/=', ''), 21);
      INSERT INTO public.tenants (id, name, created_at) VALUES (new_tenant_id, 'My Workspace', now());
      INSERT INTO public.tenant_plans (tenant_id, plan, created_at, updated_at) VALUES (new_tenant_id, 'free', now(), now());
      INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at) VALUES (new_tenant_id, account_id, 'owner', now());
    END LOOP;
  END IF;
END $$;
