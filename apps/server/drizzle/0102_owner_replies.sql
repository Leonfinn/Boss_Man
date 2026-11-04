CREATE TABLE "owner_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"agent_id" uuid,
	"state" text NOT NULL,
	"run_id" uuid,
	"reminders" integer DEFAULT 0 NOT NULL,
	"stand_in_agent_id" uuid,
	"alert_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text
);
--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_stand_in_agent_id_agents_id_fk" FOREIGN KEY ("stand_in_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_alert_decision_id_decisions_id_fk" FOREIGN KEY ("alert_decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_replies_open" ON "owner_replies" USING btree ("company_id","cleared_at","created_at");
--> statement-breakpoint
CREATE INDEX "runs_ticket_open" ON "runs" USING btree ("ticket_id","ended_at");
