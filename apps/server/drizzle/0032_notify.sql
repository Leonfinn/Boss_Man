ALTER TYPE "public"."wake_status" ADD VALUE 'steered';--> statement-breakpoint
CREATE TABLE "nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"ticket_id" uuid,
	"dropped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_ci" text;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nudges_pair" ON "nudges" USING btree ("from_agent_id","to_agent_id","created_at");