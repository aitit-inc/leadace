CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text,
	"prompt" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"hour" smallint NOT NULL,
	"days_of_week" smallint DEFAULT 127 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_key" text,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_schedules_hour" CHECK ("schedules"."hour" BETWEEN 0 AND 23),
	CONSTRAINT "chk_schedules_days_of_week" CHECK ("schedules"."days_of_week" BETWEEN 1 AND 127)
);
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "fk_schedules_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_schedules_enabled" ON "schedules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_schedules_project" ON "schedules" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON schedules
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON schedules TO app_rls;--> statement-breakpoint
-- Every project running the hosted daily cycle becomes one schedule saying so.
-- The hour was a UTC hour, so the zone is UTC; the run acts as the tenant owner.
INSERT INTO schedules (id, tenant_id, project_id, user_id, prompt, timezone, hour, days_of_week, enabled)
SELECT
  md5(random()::text || ps.project_id),
  ps.tenant_id,
  ps.project_id,
  m.user_id,
  'Run today''s cycle for up to ' || ps.hosted_cycle_outbound_count || ' prospects.',
  'UTC',
  ps.hosted_cycle_hour_utc,
  127,
  true
FROM project_settings ps
JOIN LATERAL (
  SELECT user_id FROM tenant_members
  WHERE tenant_id = ps.tenant_id
  ORDER BY (role = 'owner') DESC, created_at
  LIMIT 1
) m ON true
WHERE ps.hosted_cycle_enabled;
