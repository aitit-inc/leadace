CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'applied', 'stopped', 'outdated');--> statement-breakpoint
ALTER TYPE "public"."policy_target" ADD VALUE 'settings';--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"change" jsonb NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_changes" ADD COLUMN "reach_diff" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "fk_proposal_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposals_pending_loosen" ON "proposals" USING btree ("project_id") WHERE "proposals"."status" = 'pending' AND "proposals"."change"->>'kind' = 'loosen';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposals_add_means" ON "proposals" USING btree ("project_id",("change"->>'strategy')) WHERE "proposals"."change"->>'kind' = 'add-means';--> statement-breakpoint
CREATE INDEX "idx_proposals_tenant" ON "proposals" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_proposals_project_created" ON "proposals" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "policy_changes" ADD CONSTRAINT "chk_policy_changes_reach" CHECK (("policy_changes"."target"::text = 'settings') = ("policy_changes"."reach_diff" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposals
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON proposals TO app_rls;--> statement-breakpoint
-- Proposals replace suggestions. A means asked before keeps the person's answer;
-- the other kinds were text nothing could apply.
INSERT INTO proposals (tenant_id, project_id, change, title, body, status, created_at)
SELECT tenant_id, project_id,
       jsonb_build_object('kind', 'add-means', 'strategy', dedupe_key, 'instruction', command),
       title, body,
       (CASE status WHEN 'open' THEN 'pending' WHEN 'done' THEN 'applied' ELSE 'stopped' END)::proposal_status,
       created_at
FROM suggestions
WHERE kind = 'add-means';
