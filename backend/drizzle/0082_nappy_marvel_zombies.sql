ALTER TABLE "project_settings" DROP CONSTRAINT "chk_hosted_cycle_hour";--> statement-breakpoint
ALTER TABLE "project_settings" DROP CONSTRAINT "chk_hosted_cycle_outbound_count";--> statement-breakpoint
ALTER TABLE "project_settings" DROP COLUMN "hosted_cycle_enabled";--> statement-breakpoint
ALTER TABLE "project_settings" DROP COLUMN "hosted_cycle_hour_utc";--> statement-breakpoint
ALTER TABLE "project_settings" DROP COLUMN "hosted_cycle_outbound_count";