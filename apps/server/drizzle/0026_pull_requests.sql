ALTER TABLE "projects" ADD COLUMN "landing" text DEFAULT 'merge' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_host" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_api_base" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_url" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_number" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_note" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_head" text;