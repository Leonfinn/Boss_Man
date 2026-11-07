ALTER TABLE "tickets" ADD COLUMN "progress_head" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ceo_plan" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ceo_plan_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ceo_plan_alerted_at" timestamp with time zone;