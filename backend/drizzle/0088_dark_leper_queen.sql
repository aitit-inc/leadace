CREATE TABLE "project_sending_identities" (
	"project_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "project_sending_identities_project_id_identity_id_pk" PRIMARY KEY("project_id","identity_id"),
	CONSTRAINT "uq_project_sending_identities_position" UNIQUE("project_id","position")
);
--> statement-breakpoint
ALTER TABLE "project_settings" DROP CONSTRAINT "fk_project_settings_sending_identity";
--> statement-breakpoint
ALTER TABLE "project_sending_identities" ADD CONSTRAINT "project_sending_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sending_identities" ADD CONSTRAINT "fk_project_sending_identities_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sending_identities" ADD CONSTRAINT "fk_project_sending_identities_identity" FOREIGN KEY ("tenant_id","identity_id") REFERENCES "public"."sending_identities"("tenant_id","identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sending_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON project_sending_identities
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON project_sending_identities TO app_rls;--> statement-breakpoint
-- A project's single assigned mailbox becomes a one-entry priority list.
INSERT INTO project_sending_identities (project_id, tenant_id, identity_id, position)
SELECT project_id, tenant_id, sending_identity_id, 0
FROM project_settings
WHERE sending_identity_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" DROP COLUMN "sending_identity_id";