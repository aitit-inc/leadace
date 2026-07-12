ALTER TYPE "public"."channel" ADD VALUE 'platform';--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "platform_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_prospect_unique_platform" ON "prospects" USING btree ("tenant_id","platform_url") WHERE "prospects"."platform_url" IS NOT NULL;