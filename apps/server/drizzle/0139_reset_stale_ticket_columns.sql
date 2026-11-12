-- BOS-922 (DR-047 point 6): quiet state writes left some tickets in a column of another state. Put each one
-- in the first column of its project for its state. A ticket with no such column keeps its column.
UPDATE "tickets" t
SET "column_id" = (
  SELECT c."id" FROM "workflow_columns" c
  WHERE c."project_id" = t."project_id" AND c."system_state" = t."system_state"
  ORDER BY c."position" ASC, c."id" ASC
  LIMIT 1
)
WHERE t."column_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "workflow_columns" c WHERE c."id" = t."column_id" AND c."system_state" = t."system_state")
  AND EXISTS (SELECT 1 FROM "workflow_columns" c WHERE c."project_id" = t."project_id" AND c."system_state" = t."system_state");
