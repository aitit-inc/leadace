CREATE TYPE "public"."skip_reason" AS ENUM('bad_timing', 'no_fresh_material', 'other');--> statement-breakpoint
ALTER TYPE "public"."outreach_status" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD COLUMN "skip_reason" "skip_reason";