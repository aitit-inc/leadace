CREATE TYPE "public"."sending_identity_provider" AS ENUM('gmail_oauth', 'smtp_imap');--> statement-breakpoint
CREATE TABLE "sending_identities" (
	"tenant_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" "sending_identity_provider" NOT NULL,
	"from_email" text NOT NULL,
	"scope" text NOT NULL,
	"secret" "bytea" NOT NULL,
	"warmup_started_at" timestamp with time zone,
	"warmup_enabled" boolean DEFAULT true NOT NULL,
	"daily_cap_override" integer,
	"paused_until" timestamp with time zone,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sending_identities_tenant_id_identity_id_pk" PRIMARY KEY("tenant_id","identity_id"),
	CONSTRAINT "uq_sending_identities_tenant_user_provider" UNIQUE("tenant_id","user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD COLUMN "sending_identity_id" text;--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD COLUMN "from_email" text;--> statement-breakpoint
ALTER TABLE "sending_identities" ADD CONSTRAINT "sending_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sending_identities_tenant_provider" ON "sending_identities" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
ALTER TABLE "sending_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sending_identities
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sending_identities TO app_rls;--> statement-breakpoint
-- Backfill existing Gmail credentials into the generalized table. secret is the
-- already-pgp_sym_encrypt'd refresh token copied byte-for-byte (the encryption
-- key is unavailable at migration time, so it is never re-encrypted). identity_id
-- is a fresh opaque id; runtime-created identities use a 21-char nanoid instead.
INSERT INTO sending_identities
  (tenant_id, identity_id, user_id, provider, from_email, scope, secret,
   warmup_started_at, warmup_enabled, daily_cap_override, paused_until, granted_at, updated_at)
SELECT tenant_id, replace(gen_random_uuid()::text, '-', ''), user_id,
       'gmail_oauth'::sending_identity_provider, email, scope, refresh_token,
       warmup_started_at, warmup_enabled, daily_cap_override, paused_until, granted_at, updated_at
FROM gmail_credentials;