-- Data migration: convert is_unlimited=true rows to plan='unlimited' before dropping the column.
UPDATE "tenant_plans" SET "plan" = 'unlimited' WHERE "is_unlimited" = true;
--> statement-breakpoint
ALTER TABLE "tenant_plans" DROP COLUMN "is_unlimited";
