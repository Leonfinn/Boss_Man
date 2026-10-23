ALTER TABLE "companies" ADD COLUMN "goal_check_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "goal_check_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "goal_check_raised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "goal_check_answer" text;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "goal_check_answered_at" timestamp with time zone;