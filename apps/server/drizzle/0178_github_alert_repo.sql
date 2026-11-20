ALTER TABLE "github_alert_tickets" ADD COLUMN "repo" text;--> statement-breakpoint
UPDATE "github_alert_tickets" SET "repo" = (SELECT w."repo" FROM "github_watches" w WHERE w."project_id" = "github_alert_tickets"."project_id") WHERE "repo" IS NULL;
