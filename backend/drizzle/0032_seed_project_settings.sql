-- Backfill a project_settings row for every project that lacks one; from now on
-- createProject seeds it. Non-identity columns take their schema-level defaults.
INSERT INTO project_settings (project_id, tenant_id)
SELECT id, tenant_id FROM projects
ON CONFLICT (project_id) DO NOTHING;
