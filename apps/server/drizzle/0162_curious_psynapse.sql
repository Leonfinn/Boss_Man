CREATE TABLE "github_watches" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"repo" text,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"watch_issues" boolean DEFAULT true NOT NULL,
	"watch_discussions" boolean DEFAULT true NOT NULL,
	"skip_logins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issues_cursor" timestamp with time zone,
	"comments_cursor" timestamp with time zone,
	"discussions_cursor" timestamp with time zone,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_new_notes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "github_watches" ADD CONSTRAINT "github_watches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_watches" ADD CONSTRAINT "github_watches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_notes_external_id" ON "feedback_notes" USING btree ("company_id","external_id") WHERE "feedback_notes"."external_id" is not null;