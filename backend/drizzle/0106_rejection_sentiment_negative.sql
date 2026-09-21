-- record_response now settles a rejection's sentiment from the type. Rows
-- written before that kept whatever the caller read — an unsubscribe reply
-- landed neutral, because the reply ingest hard-codes neutral for its
-- deterministic types.
UPDATE "responses"
SET "sentiment" = 'negative'
WHERE "response_type" = 'rejection' AND "sentiment" <> 'negative';
