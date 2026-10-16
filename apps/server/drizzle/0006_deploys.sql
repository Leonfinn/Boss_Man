CREATE TYPE "public"."deploy_status" AS ENUM('pending_approval', 'approved', 'rejected', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"agent_id" uuid,
	"ticket_id" uuid,
	"ref" text NOT NULL,
	"notes" text,
	"status" "deploy_status" DEFAULT 'pending_approval' NOT NULL,
	"run_id" uuid,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "deploy_id" uuid;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_target_id_deploy_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."deploy_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_deploy_id_deploys_id_fk" FOREIGN KEY ("deploy_id") REFERENCES "public"."deploys"("id") ON DELETE set null ON UPDATE no action;