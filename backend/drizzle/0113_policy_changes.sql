CREATE TYPE "public"."policy_actor" AS ENUM('rule', 'ace', 'user');--> statement-breakpoint
CREATE TYPE "public"."policy_op" AS ENUM('add', 'update', 'archive', 'restore');--> statement-breakpoint
CREATE TYPE "public"."policy_rule_reason" AS ENUM('lost', 'rotated');--> statement-breakpoint
CREATE TYPE "public"."policy_target" AS ENUM('variant', 'strategy', 'business', 'sales_strategy');--> statement-breakpoint
CREATE TABLE "policy_changes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "policy_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"target" "policy_target" NOT NULL,
	"option_id" text,
	"op" "policy_op" NOT NULL,
	"actor" "policy_actor" NOT NULL,
	"reason" text,
	"rule_reason" "policy_rule_reason",
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_policy_changes_option_id" CHECK (("policy_changes"."target" IN ('variant', 'strategy')) = ("policy_changes"."option_id" IS NOT NULL)),
	CONSTRAINT "chk_policy_changes_rule" CHECK (("policy_changes"."actor" = 'rule') = ("policy_changes"."rule_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "policy_changes" ADD CONSTRAINT "policy_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_changes" ADD CONSTRAINT "fk_policy_change_project_tenant" FOREIGN KEY ("project_id","tenant_id") REFERENCES "public"."projects"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_policy_changes_project_created" ON "policy_changes" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_policy_changes_tenant" ON "policy_changes" USING btree ("tenant_id");--> statement-breakpoint
-- The log starts with what is already known: the tick's archives are in
-- lever_decisions; the Web UI had no way to add or archive an option, so
-- every add and every other archive was Ace's.
INSERT INTO "policy_changes" ("tenant_id", "project_id", "target", "option_id", "op", "actor", "rule_reason", "evidence", "created_at")
SELECT ld."tenant_id", ld."project_id", 'variant', a->>'variantId', 'archive', 'rule',
  CASE WHEN a->>'reason' = 'stagnation' THEN 'rotated' ELSE 'lost' END::"policy_rule_reason",
  CASE WHEN a ? 'pBest' AND a ? 'n' THEN jsonb_build_object('pBest', a->'pBest', 'n', a->'n') END, ld."created_at"
FROM "lever_decisions" ld, jsonb_array_elements(ld."decision"->'subject'->'archived') a;--> statement-breakpoint
INSERT INTO "policy_changes" ("tenant_id", "project_id", "target", "option_id", "op", "actor", "rule_reason", "evidence", "created_at")
SELECT ld."tenant_id", ld."project_id", 'strategy', a->>'slug', 'archive', 'rule', 'lost',
  CASE WHEN a ? 'pBest' AND a ? 'n' THEN jsonb_build_object('pBest', a->'pBest', 'n', a->'n') END, ld."created_at"
FROM "lever_decisions" ld, jsonb_array_elements(COALESCE(ld."decision"->'discovery'->'archived', '[]'::jsonb)) a;--> statement-breakpoint
INSERT INTO "policy_changes" ("tenant_id", "project_id", "target", "option_id", "op", "actor", "created_at")
SELECT "tenant_id", "project_id", 'variant', "variant_id", 'add', 'ace', "created_at" FROM "message_variants";--> statement-breakpoint
INSERT INTO "policy_changes" ("tenant_id", "project_id", "target", "option_id", "op", "actor", "created_at")
SELECT "tenant_id", "project_id", 'strategy', "slug", 'add', 'ace', "created_at" FROM "discovery_strategies";--> statement-breakpoint
INSERT INTO "policy_changes" ("tenant_id", "project_id", "target", "option_id", "op", "actor", "created_at")
SELECT mv."tenant_id", mv."project_id", 'variant', mv."variant_id", 'archive', 'ace', mv."archived_at"
FROM "message_variants" mv
WHERE mv."archived_at" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "policy_changes" pc
  WHERE pc."project_id" = mv."project_id" AND pc."target" = 'variant' AND pc."option_id" = mv."variant_id" AND pc."op" = 'archive'
    AND (pc."created_at" AT TIME ZONE 'UTC')::date = (mv."archived_at" AT TIME ZONE 'UTC')::date
);--> statement-breakpoint
INSERT INTO "policy_changes" ("tenant_id", "project_id", "target", "option_id", "op", "actor", "created_at")
SELECT ds."tenant_id", ds."project_id", 'strategy', ds."slug", 'archive', 'ace', ds."archived_at"
FROM "discovery_strategies" ds
WHERE ds."archived_at" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "policy_changes" pc
  WHERE pc."project_id" = ds."project_id" AND pc."target" = 'strategy' AND pc."option_id" = ds."slug" AND pc."op" = 'archive'
    AND (pc."created_at" AT TIME ZONE 'UTC')::date = (ds."archived_at" AT TIME ZONE 'UTC')::date
);--> statement-breakpoint
ALTER TABLE policy_changes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON policy_changes
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_changes TO app_rls;
