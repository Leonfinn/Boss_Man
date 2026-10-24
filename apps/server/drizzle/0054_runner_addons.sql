ALTER TABLE "runners" ADD COLUMN "addons" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "requires_addons" jsonb;