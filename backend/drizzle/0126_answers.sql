CREATE TYPE "public"."answer_status" AS ENUM('draft', 'sending', 'sent');--> statement-breakpoint
CREATE TABLE "answers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "answers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"response_id" integer NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"ace_body" text,
	"body" text,
	"status" "answer_status" DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "uq_answers_response" UNIQUE("response_id")
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "fk_answer_response_tenant" FOREIGN KEY ("response_id","tenant_id") REFERENCES "public"."responses"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_answers_tenant" ON "answers" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON answers
  FOR ALL TO app_rls
  USING (tenant_id = current_setting('app.tenant_id', true)::text)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::text);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON answers TO app_rls;
