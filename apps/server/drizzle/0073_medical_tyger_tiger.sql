ALTER TABLE "decisions" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "state_note_stale_at" timestamp with time zone;