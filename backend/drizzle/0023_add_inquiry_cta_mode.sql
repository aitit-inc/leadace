CREATE TYPE "public"."inquiry_cta_type" AS ENUM('meeting', 'signup');--> statement-breakpoint
ALTER TYPE "public"."inquiry_outcome" ADD VALUE 'signup_clicked' BEFORE 'unsubscribed';--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_cta_type" "inquiry_cta_type" DEFAULT 'meeting' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_cta_url" text;--> statement-breakpoint
UPDATE "project_settings" SET "inquiry_cta_url" = "inquiry_scheduling_url" WHERE "inquiry_scheduling_url" IS NOT NULL;