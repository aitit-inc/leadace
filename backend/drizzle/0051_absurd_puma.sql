ALTER TABLE "project_settings" ALTER COLUMN "inquiry_landing_enabled" SET DEFAULT false;--> statement-breakpoint
-- Backfill: make every existing project link-free by default. The shared
-- app-domain inquiry link was the dominant spam trigger; opt back in per project.
UPDATE "project_settings" SET "inquiry_landing_enabled" = false WHERE "inquiry_landing_enabled" = true;