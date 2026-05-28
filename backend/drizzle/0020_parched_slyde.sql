CREATE TYPE "public"."bug_report_category" AS ENUM('bug', 'feedback', 'idea');--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bug_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"category" "bug_report_category" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bug_reports_tenant_created" ON "bug_reports" USING btree ("tenant_id","created_at");--> statement-breakpoint

-- RLS: tenant isolation, identical to other tenant-scoped tables.
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON bug_reports
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);