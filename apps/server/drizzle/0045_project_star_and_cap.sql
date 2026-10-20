ALTER TABLE "projects" ADD COLUMN "starred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "monthly_cap_micros" bigint;