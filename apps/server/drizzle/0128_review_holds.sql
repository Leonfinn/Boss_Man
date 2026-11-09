CREATE TABLE "review_hold_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"blocker_ticket_id" uuid,
	"blocker_decision_id" uuid,
	CONSTRAINT "review_hold_waits_one_blocker" CHECK (num_nonnulls("review_hold_waits"."blocker_ticket_id", "review_hold_waits"."blocker_decision_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "review_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"review_request_id" uuid,
	"reviewer_agent_id" uuid,
	"reason" text NOT NULL,
	"release_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"woken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_hold_waits" ADD CONSTRAINT "review_hold_waits_hold_id_review_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."review_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_hold_waits" ADD CONSTRAINT "review_hold_waits_blocker_ticket_id_tickets_id_fk" FOREIGN KEY ("blocker_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_hold_waits" ADD CONSTRAINT "review_hold_waits_blocker_decision_id_decisions_id_fk" FOREIGN KEY ("blocker_decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_holds" ADD CONSTRAINT "review_holds_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_holds" ADD CONSTRAINT "review_holds_review_request_id_review_requests_id_fk" FOREIGN KEY ("review_request_id") REFERENCES "public"."review_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_holds" ADD CONSTRAINT "review_holds_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_hold_waits_hold" ON "review_hold_waits" USING btree ("hold_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_holds_one_open" ON "review_holds" USING btree ("ticket_id") WHERE "review_holds"."status" = 'open';--> statement-breakpoint
CREATE INDEX "review_holds_ticket" ON "review_holds" USING btree ("ticket_id");