ALTER TABLE "project_settings" ADD COLUMN "target_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "chk_target_language" CHECK ("project_settings"."target_language" IN ('en', 'ja'));--> statement-breakpoint
-- Backfill: 'ja' only when the evidence is unambiguous — the project has at
-- least one prospect with a known effective country, every known effective
-- country is JP, and any target_countries restriction is unset or exactly
-- {JP}. Everything else stays 'en' (the safe default in both directions:
-- an English footer still satisfies 特電法's display duties for JP
-- recipients, while a Japanese-only opt-out to US/CA recipients would not
-- be "clear and conspicuous"). Runs verbatim on self-host DBs.
UPDATE "project_settings" ps
SET "target_language" = 'ja'
WHERE (ps."target_countries" = '{}' OR ps."target_countries" = '{JP}')
  AND EXISTS (
    SELECT 1
    FROM "project_prospects" pp
    JOIN "prospects" p ON p."id" = pp."prospect_id"
    JOIN "organizations" o ON o."id" = p."organization_id"
    WHERE pp."project_id" = ps."project_id"
      AND COALESCE(p."country", o."country") IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "project_prospects" pp
    JOIN "prospects" p ON p."id" = pp."prospect_id"
    JOIN "organizations" o ON o."id" = p."organization_id"
    WHERE pp."project_id" = ps."project_id"
      AND COALESCE(p."country", o."country") IS NOT NULL
      AND UPPER(COALESCE(p."country", o."country")) <> 'JP'
  );