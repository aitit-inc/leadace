ALTER TABLE "org_signals_global" ADD COLUMN "last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD COLUMN "had_fresh_signal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: existing rows were last attempted when their (pre-split,
-- bumped-on-every-outcome) signals_updated_at was written; created_at covers
-- rows that somehow lack it. Without this, every existing row would read
-- "attempted just now" and stall the picker rotation for a full interval.
UPDATE "org_signals_global" SET "last_attempt_at" = COALESCE("signals_updated_at", "created_at");