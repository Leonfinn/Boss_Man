ALTER TABLE "review_holds" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_holds" ADD COLUMN "escalated_at" timestamp with time zone;