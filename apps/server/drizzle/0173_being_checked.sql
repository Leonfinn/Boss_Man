ALTER TABLE "tickets" ADD COLUMN "check_hold_at" timestamp with time zone;--> statement-breakpoint
-- BOS-1906, once: a built ticket that only waits on the quick check its agent asked for moves into "Being checked" (Review, held).
-- Tickets with no queued or running check keep their state, as does merged work.
UPDATE "tickets" t SET
  "system_state" = 'review',
  "column_id" = (SELECT c."id" FROM "workflow_columns" c WHERE c."project_id" = t."project_id" AND c."system_state" = 'review' ORDER BY c."position" LIMIT 1),
  "check_hold_at" = now()
WHERE t."system_state" = 'in_progress'
  AND t."merged_at" IS NULL
  AND EXISTS (SELECT 1 FROM "workflow_columns" c WHERE c."project_id" = t."project_id" AND c."system_state" = 'review')
  AND EXISTS (SELECT 1 FROM "check_jobs" cj WHERE cj."ticket_id" = t."id" AND cj."kind" = 'pre_review' AND cj."state" IN ('queued', 'running') AND cj."requested_by" IS NOT NULL);
