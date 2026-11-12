ALTER TABLE "review_requests" ADD COLUMN "head" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "fixes_merge_check" boolean DEFAULT false NOT NULL;