ALTER TABLE "notifications" ADD COLUMN "push_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "push_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "push_clear_note" text;