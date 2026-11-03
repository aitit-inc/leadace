ALTER TABLE "responses" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
-- Replies from before answers were tracked. Past 30 days they are taken as
-- handled, so the waiting list starts with what a person can still act on;
-- newer ones are checked against their threads by the next reply polls.
UPDATE "responses" SET "answered_at" = "received_at"
WHERE "response_type" IN ('reply', 'meeting_request')
  AND "received_at" < now() - interval '30 days';
