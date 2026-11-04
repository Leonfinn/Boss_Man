CREATE TABLE "check_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'full' NOT NULL,
	"commit" text NOT NULL,
	"tree" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"fixes_main" boolean DEFAULT false NOT NULL,
	"requested_by" uuid,
	"runner_id" uuid,
	"command" text,
	"exit_code" integer,
	"reason" text,
	"log_tail" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"last_output_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "main_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "main_state_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "main_state_commit" text;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD CONSTRAINT "check_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD CONSTRAINT "check_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD CONSTRAINT "check_jobs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD CONSTRAINT "check_jobs_requested_by_agents_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD CONSTRAINT "check_jobs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_jobs_state_queued" ON "check_jobs" USING btree ("state","queued_at");--> statement-breakpoint
CREATE INDEX "check_jobs_ticket" ON "check_jobs" USING btree ("ticket_id","queued_at");--> statement-breakpoint
CREATE INDEX "check_jobs_project_tree" ON "check_jobs" USING btree ("project_id","tree");
