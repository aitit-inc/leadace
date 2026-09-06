CREATE TYPE "public"."chat_role" AS ENUM('user', 'model', 'tool', 'job');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('daily_cycle', 'discover', 'enrich', 'draft', 'send', 'evaluate', 'journal');--> statement-breakpoint
CREATE TYPE "public"."job_origin" AS ENUM('cron', 'chat', 'ui', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"role" "chat_role" NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"pending_call" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" "job_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb,
	"result" jsonb,
	"error" text,
	"started_by" "job_origin" NOT NULL,
	"thread_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_jobs_idempotency_key" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "hosted_cycle_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "hosted_cycle_hour_utc" smallint DEFAULT 13 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "fk_chat_threads_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread" ON "chat_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_tenant" ON "chat_messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_tenant_updated" ON "chat_threads" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_project_created" ON "jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_tenant" ON "jobs" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "chk_hosted_cycle_hour" CHECK ("project_settings"."hosted_cycle_hour_utc" BETWEEN 0 AND 23);--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO app_rls;--> statement-breakpoint
ALTER TABLE "chat_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON chat_threads
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_threads TO app_rls;--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON chat_messages
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO app_rls;
