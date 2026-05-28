CREATE TYPE "public"."country_source" AS ENUM('tld_inferred', 'manual', 'ai_inferred');--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD COLUMN "context_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "country_source" "country_source";--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "subject_variant_cursor" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "country_source" "country_source";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "physical_address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_sender_country" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "privacy_policy_url" text;