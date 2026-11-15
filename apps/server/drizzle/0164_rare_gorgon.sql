ALTER TABLE "check_workers" ADD COLUMN "takes" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "check_workers" ADD COLUMN "merge_kept" integer DEFAULT 0 NOT NULL;