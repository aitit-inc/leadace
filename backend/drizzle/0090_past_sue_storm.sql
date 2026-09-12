ALTER TABLE "jobs" DROP CONSTRAINT "uq_jobs_idempotency_key";--> statement-breakpoint
UPDATE "jobs" SET "status" = 'failed', "error" = 'Superseded by a newer daily cycle when the in-flight lock was introduced', "finished_at" = now()
WHERE "kind" = 'daily_cycle' AND "status" IN ('queued', 'running')
  AND EXISTS (SELECT 1 FROM "jobs" n WHERE n."project_id" = "jobs"."project_id" AND n."kind" = 'daily_cycle' AND n."status" IN ('queued', 'running') AND n."created_at" > "jobs"."created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_daily_cycle_in_flight" ON "jobs" USING btree ("project_id") WHERE "jobs"."kind" = 'daily_cycle' AND "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "idempotency_key";