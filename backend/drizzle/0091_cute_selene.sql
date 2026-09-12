DROP INDEX "uq_sending_identities_gmail_per_user";--> statement-breakpoint
ALTER TABLE "sending_identities" ADD COLUMN "sign_in_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "sending_identities" SET "sign_in_account" = true WHERE "provider" = 'gmail_oauth' AND "parent_identity_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sending_identities_sign_in_per_user" ON "sending_identities" USING btree ("tenant_id","user_id") WHERE "sending_identities"."sign_in_account";--> statement-breakpoint
ALTER TABLE "sending_identities" ADD CONSTRAINT "chk_sending_identities_sign_in_gmail" CHECK (NOT "sending_identities"."sign_in_account" OR ("sending_identities"."provider" = 'gmail_oauth' AND "sending_identities"."parent_identity_id" IS NULL));
