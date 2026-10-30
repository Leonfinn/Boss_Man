ALTER TABLE "features" ADD COLUMN "public_summary" text;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "show_publicly" boolean DEFAULT false NOT NULL;