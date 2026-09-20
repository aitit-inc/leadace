CREATE TYPE "public"."notification_category" AS ENUM('general', 'cron');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"category" "notification_category" NOT NULL,
	"reference" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"link" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_notifications_reference" UNIQUE("tenant_id","reference")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_general_in_app" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_general_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_cron_in_app" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notify_cron_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notifications_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_tenant" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON notifications
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO app_rls;
