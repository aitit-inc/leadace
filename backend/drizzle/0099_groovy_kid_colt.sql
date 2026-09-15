ALTER TABLE "chat_threads" ADD COLUMN "read_through" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "chat_threads" SET "read_through" = COALESCE((SELECT max("id") FROM "chat_messages" WHERE "chat_messages"."thread_id" = "chat_threads"."id"), 0);
