ALTER TABLE "projects" ADD COLUMN "repo_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_branch" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "base_commit" text;