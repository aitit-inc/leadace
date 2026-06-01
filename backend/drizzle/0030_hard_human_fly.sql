ALTER TABLE "evaluations" DROP CONSTRAINT "evaluations_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "inquiry_sessions" DROP CONSTRAINT "inquiry_sessions_prospect_id_prospects_id_fk";
--> statement-breakpoint
ALTER TABLE "inquiry_sessions" DROP CONSTRAINT "inquiry_sessions_outreach_log_id_outreach_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "inquiry_sessions" DROP CONSTRAINT "inquiry_sessions_short_id_inquiry_tokens_short_id_fk";
--> statement-breakpoint
ALTER TABLE "inquiry_tokens" DROP CONSTRAINT "inquiry_tokens_prospect_id_prospects_id_fk";
--> statement-breakpoint
ALTER TABLE "inquiry_tokens" DROP CONSTRAINT "inquiry_tokens_outreach_log_id_outreach_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "outreach_logs" DROP CONSTRAINT "outreach_logs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "outreach_logs" DROP CONSTRAINT "outreach_logs_prospect_id_prospects_id_fk";
--> statement-breakpoint
ALTER TABLE "project_documents" DROP CONSTRAINT "project_documents_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "project_settings" DROP CONSTRAINT "project_settings_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "prospects" DROP CONSTRAINT "prospects_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "responses" DROP CONSTRAINT "responses_outreach_log_id_outreach_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "subject_variants" DROP CONSTRAINT "subject_variants_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "inquiry_tokens" ADD CONSTRAINT "uq_inquiry_token_short_id_tenant" UNIQUE("short_id","tenant_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "uq_org_id_tenant" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD CONSTRAINT "uq_outreach_id_tenant" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "fk_evaluation_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "fk_inquiry_session_prospect_tenant" FOREIGN KEY ("prospect_id","tenant_id") REFERENCES "public"."prospects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "fk_inquiry_session_outreach_tenant" FOREIGN KEY ("outreach_log_id","tenant_id") REFERENCES "public"."outreach_logs"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "fk_inquiry_session_token_tenant" FOREIGN KEY ("short_id","tenant_id") REFERENCES "public"."inquiry_tokens"("short_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_tokens" ADD CONSTRAINT "fk_inquiry_token_prospect_tenant" FOREIGN KEY ("prospect_id","tenant_id") REFERENCES "public"."prospects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_tokens" ADD CONSTRAINT "fk_inquiry_token_outreach_tenant" FOREIGN KEY ("outreach_log_id","tenant_id") REFERENCES "public"."outreach_logs"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD CONSTRAINT "fk_outreach_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_logs" ADD CONSTRAINT "fk_outreach_prospect_tenant" FOREIGN KEY ("prospect_id","tenant_id") REFERENCES "public"."prospects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "fk_project_document_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "fk_project_settings_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "fk_prospect_org_tenant" FOREIGN KEY ("organization_id","tenant_id") REFERENCES "public"."organizations"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "fk_response_outreach_tenant" FOREIGN KEY ("outreach_log_id","tenant_id") REFERENCES "public"."outreach_logs"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_variants" ADD CONSTRAINT "fk_subject_variant_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
