CREATE TYPE "public"."account_deletion_reason" AS ENUM('too_expensive', 'not_enough_results', 'missing_features', 'too_hard_to_use', 'switched_to_alternative', 'no_longer_needed', 'other');--> statement-breakpoint
CREATE TABLE "account_deletion_surveys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_deletion_surveys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"reason" "account_deletion_reason" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Admin-only (written via the raw adminDb superuser, which bypasses RLS): undo
-- the app_rls grant 0001 auto-applies, and deny-all every other role. The free
-- text could hold personal data, so no request-role query may read it.
REVOKE ALL ON "account_deletion_surveys" FROM app_rls;--> statement-breakpoint
REVOKE ALL ON SEQUENCE "account_deletion_surveys_id_seq" FROM app_rls;--> statement-breakpoint
ALTER TABLE "account_deletion_surveys" ENABLE ROW LEVEL SECURITY;
