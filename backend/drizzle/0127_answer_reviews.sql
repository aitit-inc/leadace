ALTER TYPE "public"."policy_target" ADD VALUE 'answering_replies' BEFORE 'settings';--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "reviewed_at" timestamp with time zone;