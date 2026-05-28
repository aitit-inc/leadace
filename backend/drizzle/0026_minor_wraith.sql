-- F19 / F33 (Session C): composite (entity_id, tenant_id) foreign keys for
-- inquiry_messages → inquiry_sessions and project_prospects → projects /
-- prospects. These prevent cross-tenant references at write time on top of
-- the RLS-level guarantee.
--
-- Postgres rejects composite FKs whose foreignColumns do not have a matching
-- UNIQUE constraint, so the (id, tenant_id) UNIQUE constraints must be
-- created BEFORE the FKs that reference them. drizzle-kit's emitted order
-- has been reshuffled accordingly. Existing rows are expected to already
-- satisfy the composite-key invariant (application-layer write paths set
-- tenant_id consistently); if not, the FK adds will fail loudly with
-- "insert or update violates foreign key constraint" and the migration
-- rolls back.
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "uq_inquiry_session_id_tenant" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "uq_project_id_tenant" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "uq_prospect_id_tenant" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "inquiry_messages" DROP CONSTRAINT "inquiry_messages_session_id_inquiry_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "project_prospects" DROP CONSTRAINT "project_prospects_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "project_prospects" DROP CONSTRAINT "project_prospects_prospect_id_prospects_id_fk";--> statement-breakpoint
ALTER TABLE "inquiry_messages" ADD CONSTRAINT "fk_inquiry_messages_session_tenant" FOREIGN KEY ("session_id","tenant_id") REFERENCES "public"."inquiry_sessions"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_prospects" ADD CONSTRAINT "fk_project_prospect_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_prospects" ADD CONSTRAINT "fk_project_prospect_prospect_tenant" FOREIGN KEY ("prospect_id","tenant_id") REFERENCES "public"."prospects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
