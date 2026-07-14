-- Reward weights are capped at 1 as of Phase B, but the previous schema only
-- enforced min(0), so stored overrides may exceed 1 — loadLeverConfig now
-- fails loudly on them. Clamp in place; rows without an offending value are untouched.
UPDATE "project_settings"
SET "lever_config" = jsonb_set(
  "lever_config",
  '{reward}',
  (
    SELECT jsonb_object_agg(key, to_jsonb(LEAST(value::numeric, 1)))
    FROM jsonb_each_text("lever_config"->'reward')
  )
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_each_text("lever_config"->'reward')
  WHERE value::numeric > 1
);
