ALTER TABLE "check_jobs" ADD COLUMN "busy_at_start" integer;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD COLUMN "stages" text;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD COLUMN "ran_full" boolean;