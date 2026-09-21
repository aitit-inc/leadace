ALTER TYPE "public"."notification_category" ADD VALUE 'insight';--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "insight_digest_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_insight_in_app" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_insight_email" boolean DEFAULT true NOT NULL;