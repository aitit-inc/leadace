DROP INDEX "uq_sending_identities_gmail_per_user";--> statement-breakpoint
ALTER TABLE "sending_identities" ALTER COLUMN "secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_identities" ADD COLUMN "parent_identity_id" text;--> statement-breakpoint
ALTER TABLE "sending_identities" ADD CONSTRAINT "fk_sending_identities_parent" FOREIGN KEY ("tenant_id","parent_identity_id") REFERENCES "public"."sending_identities"("tenant_id","identity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sending_identities_gmail_per_user" ON "sending_identities" USING btree ("tenant_id","user_id") WHERE "sending_identities"."provider" = 'gmail_oauth' AND "sending_identities"."parent_identity_id" IS NULL;--> statement-breakpoint
-- Each project's Gmail Send-As alias becomes a mailbox of its own under the tenant's
-- connected Gmail, carrying that Gmail's warmup, cap, pause and refusal state (it sent
-- through the Gmail, so its guardrails were the Gmail's).
INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, parent_identity_id, scope, secret,
  warmup_started_at, daily_cap_override, paused_until, send_refusal, granted_at, updated_at)
SELECT a.tenant_id, encode(gen_random_bytes(16), 'hex'), a.user_id, 'gmail_oauth', a.alias, a.parent_id, NULL, NULL,
  a.warmup_started_at, a.daily_cap_override, a.paused_until, a.send_refusal, now(), now()
FROM (
  SELECT DISTINCT ON (ps.tenant_id, ps.sender_email_alias)
    ps.tenant_id, ps.sender_email_alias AS alias, g.user_id, g.identity_id AS parent_id,
    g.warmup_started_at, g.daily_cap_override, g.paused_until, g.send_refusal
  FROM project_settings ps
  JOIN sending_identities g ON g.tenant_id = ps.tenant_id AND g.provider = 'gmail_oauth' AND g.parent_identity_id IS NULL
  WHERE ps.sender_email_alias IS NOT NULL
  ORDER BY ps.tenant_id, ps.sender_email_alias, g.granted_at
) a
ON CONFLICT (tenant_id, from_email) DO NOTHING;--> statement-breakpoint
-- A project that sent from the connected Gmail as the alias now lists the mailbox that
-- owns that address (the new alias row, or an SMTP mailbox already registered on it):
-- in the Gmail's slot when the Gmail was listed, as the whole list when nothing was.
UPDATE project_sending_identities psi
SET identity_id = a.identity_id
FROM project_settings ps
JOIN sending_identities a ON a.tenant_id = ps.tenant_id AND a.from_email = ps.sender_email_alias
JOIN sending_identities g ON g.tenant_id = ps.tenant_id AND g.provider = 'gmail_oauth' AND g.parent_identity_id IS NULL
WHERE psi.project_id = ps.project_id AND psi.tenant_id = ps.tenant_id AND psi.identity_id = g.identity_id
  AND NOT EXISTS (SELECT 1 FROM project_sending_identities y WHERE y.project_id = psi.project_id AND y.identity_id = a.identity_id);--> statement-breakpoint
INSERT INTO project_sending_identities (project_id, tenant_id, identity_id, position)
SELECT ps.project_id, ps.tenant_id, a.identity_id, 0
FROM project_settings ps
JOIN sending_identities a ON a.tenant_id = ps.tenant_id AND a.from_email = ps.sender_email_alias
WHERE NOT EXISTS (SELECT 1 FROM project_sending_identities x WHERE x.project_id = ps.project_id);--> statement-breakpoint
ALTER TABLE "project_settings" DROP COLUMN "sender_email_alias";--> statement-breakpoint
ALTER TABLE "sending_identities" ADD CONSTRAINT "chk_sending_identities_secret_owner" CHECK (("sending_identities"."parent_identity_id" IS NULL) = ("sending_identities"."secret" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sending_identities" ADD CONSTRAINT "chk_sending_identities_alias_provider" CHECK ("sending_identities"."parent_identity_id" IS NULL OR "sending_identities"."provider" = 'gmail_oauth');