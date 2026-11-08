CREATE TABLE "discovery_evidence" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discovery_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" integer NOT NULL,
	"page_url" text NOT NULL,
	"claim" text,
	"stated_on" date,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_discovery_evidence_page" UNIQUE("project_id","organization_id","page_url"),
	CONSTRAINT "chk_discovery_evidence_dated_claim" CHECK ("discovery_evidence"."stated_on" IS NULL OR "discovery_evidence"."claim" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "discovery_evidence" ADD CONSTRAINT "discovery_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_evidence" ADD CONSTRAINT "fk_discovery_evidence_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_evidence" ADD CONSTRAINT "fk_discovery_evidence_org_tenant" FOREIGN KEY ("organization_id","tenant_id") REFERENCES "public"."organizations"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_discovery_evidence_tenant" ON "discovery_evidence" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "discovery_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON discovery_evidence
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON discovery_evidence TO app_rls;
