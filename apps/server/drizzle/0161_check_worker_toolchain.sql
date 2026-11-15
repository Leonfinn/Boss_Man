ALTER TABLE "check_workers" ADD COLUMN "toolchain" jsonb;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "toolchain" jsonb;