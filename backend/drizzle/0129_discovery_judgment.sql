CREATE TYPE "public"."discovery_judgment" AS ENUM('fit', 'need_outside', 'unproven', 'outside', 'unreadable');--> statement-breakpoint
ALTER TABLE "project_prospects" ADD COLUMN "judgment" "discovery_judgment" DEFAULT 'fit' NOT NULL;--> statement-breakpoint
-- Rows registered before judgments were kept: one left out of the targets was
-- not shown to be in the Target, or its site could not be read.
UPDATE "project_prospects" SET "judgment" = CASE WHEN "match_reason" = 'Its site could not be read.' THEN 'unreadable'::"discovery_judgment" ELSE 'unproven'::"discovery_judgment" END WHERE NOT "qualified";
