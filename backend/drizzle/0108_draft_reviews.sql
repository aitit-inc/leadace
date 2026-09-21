CREATE TYPE "public"."draft_review_verdict" AS ENUM('edited', 'wrong_message', 'wrong_prospect');--> statement-breakpoint
CREATE TABLE "draft_reviews" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "draft_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prospect_id" integer NOT NULL,
	"outreach_log_id" integer,
	"channel" "channel" NOT NULL,
	"verdict" "draft_review_verdict" NOT NULL,
	"note" text,
	"agent_subject" text,
	"agent_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_draft_review_outreach" UNIQUE("outreach_log_id")
);
--> statement-breakpoint
ALTER TABLE "draft_reviews" ADD CONSTRAINT "draft_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reviews" ADD CONSTRAINT "draft_reviews_outreach_log_id_outreach_logs_id_fk" FOREIGN KEY ("outreach_log_id") REFERENCES "public"."outreach_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reviews" ADD CONSTRAINT "fk_draft_review_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reviews" ADD CONSTRAINT "fk_draft_review_prospect_tenant" FOREIGN KEY ("prospect_id","tenant_id") REFERENCES "public"."prospects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_draft_reviews_tenant" ON "draft_reviews" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_draft_reviews_project" ON "draft_reviews" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "draft_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON draft_reviews
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON draft_reviews TO app_rls;
