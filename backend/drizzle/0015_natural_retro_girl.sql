CREATE TYPE "public"."inquiry_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."inquiry_outcome" AS ENUM('opened', 'inquired', 'lead', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."meeting_request_source" AS ENUM('button', 'chat');--> statement-breakpoint
CREATE TABLE "inquiry_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inquiry_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"session_id" integer NOT NULL,
	"role" "inquiry_message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiry_sessions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inquiry_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"prospect_id" integer NOT NULL,
	"outreach_log_id" integer NOT NULL,
	"short_id" text NOT NULL,
	"response_id" integer,
	"outcome" "inquiry_outcome" DEFAULT 'opened' NOT NULL,
	"meeting_request_source" "meeting_request_source",
	"derived_summary" text,
	"chat_turns_used" smallint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inquiry_tokens" (
	"short_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"prospect_id" integer NOT NULL,
	"outreach_log_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_landing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_chat_brief" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_one_liner" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_video_url" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_pdf_url" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_brand_color" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "inquiry_brand_logo_url" text;--> statement-breakpoint
ALTER TABLE "inquiry_messages" ADD CONSTRAINT "inquiry_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_messages" ADD CONSTRAINT "inquiry_messages_session_id_inquiry_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."inquiry_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "inquiry_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "inquiry_sessions_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "inquiry_sessions_outreach_log_id_outreach_logs_id_fk" FOREIGN KEY ("outreach_log_id") REFERENCES "public"."outreach_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "inquiry_sessions_short_id_inquiry_tokens_short_id_fk" FOREIGN KEY ("short_id") REFERENCES "public"."inquiry_tokens"("short_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "inquiry_sessions_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_tokens" ADD CONSTRAINT "inquiry_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_tokens" ADD CONSTRAINT "inquiry_tokens_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_tokens" ADD CONSTRAINT "inquiry_tokens_outreach_log_id_outreach_logs_id_fk" FOREIGN KEY ("outreach_log_id") REFERENCES "public"."outreach_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inquiry_messages_session" ON "inquiry_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inquiry_messages_tenant" ON "inquiry_messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_inquiry_session_tenant" ON "inquiry_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_inquiry_session_prospect" ON "inquiry_sessions" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "idx_inquiry_session_outreach" ON "inquiry_sessions" USING btree ("outreach_log_id");--> statement-breakpoint
CREATE INDEX "idx_inquiry_session_quota" ON "inquiry_sessions" USING btree ("tenant_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inquiry_session_open" ON "inquiry_sessions" USING btree ("short_id") WHERE "inquiry_sessions"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_inquiry_tokens_tenant" ON "inquiry_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_inquiry_tokens_outreach" ON "inquiry_tokens" USING btree ("outreach_log_id");--> statement-breakpoint

-- RLS: tenant isolation, identical to other tenant-scoped tables.
ALTER TABLE inquiry_tokens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inquiry_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inquiry_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON inquiry_tokens
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON inquiry_sessions
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint

CREATE POLICY tenant_isolation ON inquiry_messages
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);