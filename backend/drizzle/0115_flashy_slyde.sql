ALTER TABLE "paid_calls" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
-- Rows written before the column existed, priced as domain/paid-calls.ts priced them then.
UPDATE "paid_calls" c SET "cost_usd" = CASE
  WHEN c."model" = 'emailable' THEN 0.0076
  ELSE ((c."input_tokens" - c."cached_input_tokens" - c."cache_write_tokens") * p.input
      + c."cached_input_tokens" * p.cached + c."cache_write_tokens" * p.cache_write
      + (c."output_tokens" + c."reasoning_tokens") * p.output) / 1e6
    * CASE WHEN c."tier" = 'flex' THEN 0.5 ELSE 1 END
    + c."search_calls" * 0.01
  END
FROM (VALUES
  ('gpt-6-luna', 0.1, 0.01, 0.125, 0.5),
  ('gpt-6-sol', 2, 0.2, 2.5, 10),
  ('gpt-5.4-mini', 0.75, 0.075, 0.9375, 4.5),
  ('emailable', 0, 0, 0, 0)) AS p(model, input, cached, cache_write, output)
WHERE p.model = c."model";--> statement-breakpoint
-- Chat rows written without a project take their thread's.
UPDATE "paid_calls" c SET "project_id" = t."project_id"
FROM "chat_threads" t
WHERE c."project_id" IS NULL AND t."id" = c."thread_id" AND t."tenant_id" = c."tenant_id" AND t."project_id" IS NOT NULL;
