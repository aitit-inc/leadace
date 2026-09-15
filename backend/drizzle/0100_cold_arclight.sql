ALTER TABLE "chat_messages" ADD COLUMN "read_after" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "read_through";