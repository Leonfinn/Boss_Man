ALTER TABLE "tickets" ADD COLUMN "monitor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "monitor_note" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "monitor_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "monitor_max" integer DEFAULT 5 NOT NULL;