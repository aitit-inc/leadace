CREATE TYPE "public"."outbound_mode" AS ENUM('send', 'draft');--> statement-breakpoint
CREATE TABLE "project_settings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"outbound_mode" "outbound_mode" DEFAULT 'send' NOT NULL,
	"sender_email_alias" text,
	"sender_display_name" text,
	"unsubscribe_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_settings_tenant" ON "project_settings" USING btree ("tenant_id");--> statement-breakpoint

-- RLS: tenant isolation, identical to other tenant-scoped tables.
ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON project_settings
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);