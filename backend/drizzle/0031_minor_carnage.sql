ALTER TABLE "inquiry_sessions" DROP CONSTRAINT "inquiry_sessions_response_id_responses_id_fk";
--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "uq_response_id_tenant" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "inquiry_sessions" ADD CONSTRAINT "fk_inquiry_session_response_tenant" FOREIGN KEY ("response_id","tenant_id") REFERENCES "public"."responses"("id","tenant_id") ON DELETE no action ON UPDATE no action;
