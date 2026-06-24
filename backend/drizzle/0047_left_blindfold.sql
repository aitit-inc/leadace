ALTER TABLE "sending_identities" DROP CONSTRAINT "uq_sending_identities_tenant_user_provider";--> statement-breakpoint
ALTER TABLE "sending_identities" ALTER COLUMN "scope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "sending_identity_id" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "fk_project_settings_sending_identity" FOREIGN KEY ("tenant_id","sending_identity_id") REFERENCES "public"."sending_identities"("tenant_id","identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sending_identities_gmail_per_user" ON "sending_identities" USING btree ("tenant_id","user_id") WHERE "sending_identities"."provider" = 'gmail_oauth';--> statement-breakpoint
ALTER TABLE "sending_identities" ADD CONSTRAINT "uq_sending_identities_tenant_from_email" UNIQUE("tenant_id","from_email");