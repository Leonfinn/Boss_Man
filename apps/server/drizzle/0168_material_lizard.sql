ALTER TABLE "features" ADD COLUMN "priority_one" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "urgent_by_owner" boolean DEFAULT false NOT NULL;