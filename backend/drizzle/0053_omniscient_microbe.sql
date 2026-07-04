ALTER TABLE "project_settings" ALTER COLUMN "unsubscribe_enabled" SET DEFAULT false;
--> statement-breakpoint
-- Backfill: the toggle was a documented no-op until now, so no existing `true` is a user choice.
UPDATE "project_settings" SET "unsubscribe_enabled" = false WHERE "unsubscribe_enabled" = true;
