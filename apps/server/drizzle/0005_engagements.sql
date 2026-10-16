ALTER TABLE "companies" ADD COLUMN "owner_approves_engagements" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_messages" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "counter_terms" jsonb;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "delivery" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "engagement_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE set null ON UPDATE no action;