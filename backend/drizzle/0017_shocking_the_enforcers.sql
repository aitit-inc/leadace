CREATE TABLE "org_signals_global" (
	"domain" text PRIMARY KEY NOT NULL,
	"signals" jsonb,
	"signals_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subject_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"subject_pattern" text NOT NULL,
	"label" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_subject_variant_project" UNIQUE("project_id","variant_id")
);
--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "max_reapproach_cycles" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "unspecified_recontact_window_months" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "no_response_recycle_days" smallint DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "hypothesis" jsonb;--> statement-breakpoint
ALTER TABLE "subject_variants" ADD CONSTRAINT "subject_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_variants" ADD CONSTRAINT "subject_variants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_subject_variants_tenant" ON "subject_variants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_subject_variants_active" ON "subject_variants" USING btree ("project_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_outreach_variant" ON "outreach_logs" USING btree ("project_id","variant_id","status");--> statement-breakpoint

-- RLS: tenant isolation, identical to other tenant-scoped tables.
-- org_signals_global is intentionally NOT RLS-protected (global cache, same as master_documents).
ALTER TABLE subject_variants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON subject_variants
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);