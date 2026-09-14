CREATE TYPE "public"."credit_entry_kind" AS ENUM('purchase', 'auto_top_up', 'usage_contacted', 'usage_found');--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"kind" "credit_entry_kind" NOT NULL,
	"amount_cents" integer NOT NULL,
	"reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_credit_ledger_reference" UNIQUE("tenant_id","kind","reference")
);
--> statement-breakpoint
ALTER TABLE "tenant_plans" ADD COLUMN "auto_top_up_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_plans" ADD COLUMN "auto_top_up_amount_cents" integer DEFAULT 2500 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_plans" ADD COLUMN "auto_top_up_threshold_cents" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_plans" ADD COLUMN "auto_top_up_invoice_id" text;--> statement-breakpoint
ALTER TABLE "tenant_plans" ADD COLUMN "auto_top_up_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_tenant" ON "credit_ledger" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON credit_ledger
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_ledger TO app_rls;
