-- The vitals survival count now counts sends that drew a reply or a rewarded
-- inquiry session, and the key was renamed with it. Decision rows written
-- before the rename carry the old key; move the recorded value across so the
-- read path sees one shape.
-- jsonb_exists() rather than the ? operator: a bare ? in migration SQL reads
-- as a bound parameter.
UPDATE "lever_decisions"
SET "decision" = jsonb_set(
  "decision" #- '{vitals,replies}',
  '{vitals,engaged}',
  "decision"->'vitals'->'replies'
)
WHERE jsonb_exists("decision"->'vitals', 'replies');
