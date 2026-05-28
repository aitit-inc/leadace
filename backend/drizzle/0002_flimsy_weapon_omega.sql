ALTER TABLE "project_prospects" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "project_prospects" ALTER COLUMN "status" SET DEFAULT 'new'::text;--> statement-breakpoint
DROP TYPE "public"."prospect_status";--> statement-breakpoint
CREATE TYPE "public"."prospect_status" AS ENUM('new', 'contacted', 'responded', 'converted', 'rejected', 'inactive');--> statement-breakpoint
ALTER TABLE "project_prospects" ALTER COLUMN "status" SET DEFAULT 'new'::"public"."prospect_status";--> statement-breakpoint
ALTER TABLE "project_prospects" ALTER COLUMN "status" SET DATA TYPE "public"."prospect_status" USING "status"::"public"."prospect_status";--> statement-breakpoint
DROP INDEX "idx_org_normalized_name";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "projects" SET "name" = "id" WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "normalized_name";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "industry";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "overview";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "uq_project_tenant_name" UNIQUE("tenant_id","name");