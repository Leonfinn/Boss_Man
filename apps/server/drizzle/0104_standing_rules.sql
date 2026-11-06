ALTER TABLE "companies" ADD COLUMN "standing_rules" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "standing_rules_by" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "standing_rules_at" timestamp with time zone;