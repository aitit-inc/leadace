ALTER TABLE "responses" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "sending_identities" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_responses_source_message" ON "responses" USING btree ("tenant_id","source_message_id") WHERE "responses"."source_message_id" IS NOT NULL;