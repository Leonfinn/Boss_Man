ALTER TABLE "deploys" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "tag_name" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "tag_from" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "tag_to" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "tag_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "tag_result" text;