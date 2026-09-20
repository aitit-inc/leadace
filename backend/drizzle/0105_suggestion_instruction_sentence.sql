-- A suggestion's action is now a sentence the web UI sends to the chat, not a
-- Claude Code command, so rows written as one lose their prefix. A row that
-- would be left empty keeps what it has.
WITH converted AS (
  SELECT s."id", btrim(
    CASE
      WHEN left(s."command", length('/leadace ' || p."name" || ' ')) = '/leadace ' || p."name" || ' '
        THEN substring(s."command" FROM length('/leadace ' || p."name" || ' ') + 1)
      WHEN left(s."command", length('/leadace ' || s."project_id" || ' ')) = '/leadace ' || s."project_id" || ' '
        THEN substring(s."command" FROM length('/leadace ' || s."project_id" || ' ') + 1)
      ELSE substring(s."command" FROM length('/leadace ') + 1)
    END) AS sentence
  FROM "suggestions" AS s JOIN "projects" AS p ON p."id" = s."project_id"
  WHERE left(s."command", 9) = '/leadace '
)
UPDATE "suggestions" AS s
SET "command" = c.sentence
FROM converted AS c
WHERE c."id" = s."id" AND c.sentence <> '';
