CREATE TYPE "public"."note_request_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "agent_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"why" text NOT NULL,
	"source" text NOT NULL,
	"requested_by_agent_id" uuid,
	"ticket_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"why" text NOT NULL,
	"status" "note_request_status" DEFAULT 'pending' NOT NULL,
	"decline_reason" text,
	"note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_requests" ADD CONSTRAINT "note_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_requests" ADD CONSTRAINT "note_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_requests" ADD CONSTRAINT "note_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_requests" ADD CONSTRAINT "note_requests_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_requests" ADD CONSTRAINT "note_requests_note_id_agent_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."agent_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_notes_agent" ON "agent_notes" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "note_requests_agent_status" ON "note_requests" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "note_requests_requester_time" ON "note_requests" USING btree ("requested_by_agent_id","created_at");