-- The learnings document is gone (#919): findings go in as policy changes, and
-- save_document no longer takes the slug. Nothing reads these rows, so they
-- would otherwise linger as a dead entry in the Documents list whose save fails.
DELETE FROM project_documents WHERE slug = 'learnings';
