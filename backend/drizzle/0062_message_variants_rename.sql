-- Phase C: subject_variants becomes message_variants (a variant now bundles
-- subject + body approach). Constraint / index / sequence renames are explicit
-- because Postgres does not rename dependent objects with the table.
ALTER TABLE "subject_variants" RENAME TO "message_variants";--> statement-breakpoint
ALTER TABLE "message_variants" RENAME CONSTRAINT "subject_variants_pkey" TO "message_variants_pkey";--> statement-breakpoint
ALTER TABLE "message_variants" RENAME CONSTRAINT "subject_variants_tenant_id_tenants_id_fk" TO "message_variants_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "message_variants" RENAME CONSTRAINT "fk_subject_variant_project_tenant" TO "fk_message_variant_project_tenant";--> statement-breakpoint
ALTER TABLE "message_variants" RENAME CONSTRAINT "uq_subject_variant_project" TO "uq_message_variant_project";--> statement-breakpoint
ALTER INDEX "idx_subject_variants_tenant" RENAME TO "idx_message_variants_tenant";--> statement-breakpoint
ALTER INDEX "idx_subject_variants_active" RENAME TO "idx_message_variants_active";--> statement-breakpoint
ALTER SEQUENCE "subject_variants_id_seq" RENAME TO "message_variants_id_seq";--> statement-breakpoint
ALTER TABLE "message_variants" ADD COLUMN "body_approach" text;
