CREATE TABLE "discovery_strategies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discovery_strategies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"approach" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_discovery_strategy_project" UNIQUE("project_id","slug")
);
--> statement-breakpoint
ALTER TABLE "discovery_strategies" ADD CONSTRAINT "discovery_strategies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_strategies" ADD CONSTRAINT "fk_discovery_strategy_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_discovery_strategies_tenant" ON "discovery_strategies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_discovery_strategies_active" ON "discovery_strategies" USING btree ("project_id","archived_at");--> statement-breakpoint
ALTER TABLE "discovery_strategies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON discovery_strategies
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON discovery_strategies TO app_rls;
