-- On managed Supabase, pgcrypto lives in the `extensions` schema; routes that
-- run as `app_rls` need USAGE there to call pgp_sym_encrypt / pgp_sym_decrypt.
-- The schema doesn't exist on a vanilla local Postgres, so guard the grant.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA extensions TO app_rls';
  END IF;
END $$;
