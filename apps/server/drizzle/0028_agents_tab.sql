CREATE TABLE "agent_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"by_agent_id" uuid,
	"field" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_by_agent_id_agents_id_fk" FOREIGN KEY ("by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_changes_agent_time" ON "agent_changes" USING btree ("agent_id","created_at");