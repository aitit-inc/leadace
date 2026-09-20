ALTER TYPE "public"."notification_category" ADD VALUE 'lead';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_lead_in_app" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_lead_email" boolean DEFAULT true NOT NULL;