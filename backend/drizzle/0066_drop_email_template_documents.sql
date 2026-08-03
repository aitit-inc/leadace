-- The email_template document and the two master templates that fed it are
-- gone: the body is written per recipient from tpl_email_guidelines (shape and
-- hard rules), the project's business / sales_strategy documents (facts), and
-- the picked message variant's body approach (angle). Nothing reads these rows,
-- so they would otherwise linger as a dead, still-editable entry in the web
-- app's Documents list.
DELETE FROM project_documents WHERE slug = 'email_template';
--> statement-breakpoint
DELETE FROM master_documents WHERE slug IN ('tpl_email_base', 'tpl_email_templates');
