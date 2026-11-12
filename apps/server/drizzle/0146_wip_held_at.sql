ALTER TABLE "tickets" ADD COLUMN "wip_held_at" timestamp with time zone;--> statement-breakpoint
-- Tickets held before this carried the mark only as state-note text: move it into the field.
UPDATE "tickets" SET "wip_held_at" = coalesce("state_note_at", "state_changed_at")
WHERE "system_state" = 'ready' AND "state_note" ~ '^Waiting: .* is at the limit of [0-9]+ in-progress tickets?; starts when one finishes\.$';
