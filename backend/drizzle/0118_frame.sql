ALTER TYPE "public"."policy_target" ADD VALUE 'frame';--> statement-breakpoint
DROP INDEX "uq_proposals_pending_loosen";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposals_pending" ON "proposals" USING btree ("project_id") WHERE "proposals"."status" = 'pending' AND "proposals"."change"->>'kind' IN ('loosen', 'frame');