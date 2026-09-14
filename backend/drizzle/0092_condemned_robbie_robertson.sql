CREATE TYPE "public"."prospect_origin" AS ENUM('found', 'brought_in');--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "origin" "prospect_origin" DEFAULT 'brought_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_plans" ADD COLUMN "overage_enabled" boolean DEFAULT false NOT NULL;