CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reviewer_agent_id" uuid,
	"round" integer NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overruled_by_agent_id" uuid,
	"overrule_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "review_kind" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "review_order" jsonb;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_overruled_by_agent_id_agents_id_fk" FOREIGN KEY ("overruled_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_slot" ON "review_requests" USING btree ("ticket_id","round","kind");