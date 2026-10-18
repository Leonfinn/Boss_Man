ALTER TABLE "tickets" ADD COLUMN "watch_fingerprint" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "state_note" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "state_note_at" timestamp with time zone;