DROP TABLE "org_signals_global" CASCADE;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "site_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_logs" DROP COLUMN "had_fresh_signal";