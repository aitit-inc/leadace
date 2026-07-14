ALTER TABLE "lever_state" ADD COLUMN "targeting_lifts" jsonb;--> statement-breakpoint
ALTER TABLE "project_prospects" ADD COLUMN "ordering_score" real DEFAULT 1 NOT NULL;