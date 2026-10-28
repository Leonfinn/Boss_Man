ALTER TYPE "public"."skill_source" ADD VALUE 'retro';--> statement-breakpoint
CREATE TABLE "retros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"done_count" integer NOT NULL,
	"findings" jsonb,
	"saved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"retro_id" uuid NOT NULL,
	"lever" text NOT NULL,
	"target_agent_id" uuid,
	"target_role" text,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metric" text NOT NULL,
	"metric_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"baseline" real,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approver" text NOT NULL,
	"decision_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"applied_at" timestamp with time zone,
	"check_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retros" ADD CONSTRAINT "retros_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retros" ADD CONSTRAINT "retros_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_changes" ADD CONSTRAINT "workflow_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_changes" ADD CONSTRAINT "workflow_changes_retro_id_retros_id_fk" FOREIGN KEY ("retro_id") REFERENCES "public"."retros"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_changes" ADD CONSTRAINT "workflow_changes_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_changes" ADD CONSTRAINT "workflow_changes_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retros_company_started" ON "retros" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_changes_company" ON "workflow_changes" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_changes_retro" ON "workflow_changes" USING btree ("retro_id");