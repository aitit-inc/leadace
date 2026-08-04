ALTER TABLE "sending_identities" ADD COLUMN "poll_failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sending_identities" ADD COLUMN "last_poll_error" text;