ALTER TABLE "tickets" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "touches_runner" boolean;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "go_live_wait" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "go_live_wait_since" timestamp with time zone;