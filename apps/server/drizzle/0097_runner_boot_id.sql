ALTER TABLE "runners" ADD COLUMN "boot_id" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "boot_pulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "monitor_restart_at" timestamp with time zone;
