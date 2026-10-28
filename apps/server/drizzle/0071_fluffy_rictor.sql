ALTER TYPE "public"."decision_kind" ADD VALUE 'skill';--> statement-breakpoint
CREATE TABLE "skill_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"pinned_ref" text,
	"files" jsonb NOT NULL,
	"file_hashes" jsonb NOT NULL,
	"bundle_hash" text NOT NULL,
	"why" text NOT NULL,
	"proposed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_by_agent_id" uuid,
	"replaces_skill_id" uuid,
	"has_scripts" boolean NOT NULL,
	"script_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_required" boolean NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"review_ticket_id" uuid,
	"verdict" text,
	"verdict_summary" text,
	"findings" jsonb,
	"conditions" jsonb,
	"reviewed_bundle_hash" text,
	"decision_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"overridden" boolean DEFAULT false NOT NULL,
	"overridden_by" text,
	"overridden_at" timestamp with time zone,
	"installed_skill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_replaces_skill_id_skills_id_fk" FOREIGN KEY ("replaces_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_review_ticket_id_tickets_id_fk" FOREIGN KEY ("review_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_installed_skill_id_skills_id_fk" FOREIGN KEY ("installed_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_proposals_open_name" ON "skill_proposals" USING btree ("company_id","name") WHERE status in ('proposed','in_review','awaiting_owner');