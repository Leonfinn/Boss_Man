ALTER TABLE "companies" ADD COLUMN "max_run_minutes" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stop_reason" text;