ALTER TABLE "sending_identities" ADD COLUMN "inbox_test_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sending_identities" ADD COLUMN "inbox_test_result" jsonb;