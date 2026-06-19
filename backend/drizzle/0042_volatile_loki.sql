ALTER TABLE "outreach_logs" ADD COLUMN "touch_number" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_prospects" ADD COLUMN "next_followup_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_prospects" ADD COLUMN "followup_touches" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "follow_up_sequence" jsonb DEFAULT '{}'::jsonb NOT NULL;