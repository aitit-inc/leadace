ALTER TABLE "gmail_credentials" ADD COLUMN "warmup_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_credentials" ADD COLUMN "warmup_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_credentials" ADD COLUMN "daily_cap_override" integer;--> statement-breakpoint
ALTER TABLE "gmail_credentials" ADD COLUMN "paused_until" timestamp with time zone;