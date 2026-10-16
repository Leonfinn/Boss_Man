ALTER TABLE "companies" ADD COLUMN "disk_cap_bytes" bigint;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "disk_used_bytes" bigint;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "disk_checked_at" timestamp with time zone;