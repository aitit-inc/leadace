CREATE TABLE "chat_rate_windows" (
	"tenant_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "pk_chat_rate_windows" PRIMARY KEY("tenant_id","scope","key","window_start")
);
--> statement-breakpoint
ALTER TABLE "chat_rate_windows" ADD CONSTRAINT "chat_rate_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_rate_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON chat_rate_windows
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_rate_windows TO app_rls;