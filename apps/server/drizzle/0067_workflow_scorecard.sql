CREATE TABLE "check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"sha" text,
	"kind" text NOT NULL,
	"passed" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "ticket_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_transitions" ADD CONSTRAINT "ticket_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_transitions" ADD CONSTRAINT "ticket_transitions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_results_ticket_at" ON "check_results" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "ticket_transitions_company_at" ON "ticket_transitions" USING btree ("company_id","at");--> statement-breakpoint
CREATE INDEX "ticket_transitions_ticket_at" ON "ticket_transitions" USING btree ("ticket_id","at");--> statement-breakpoint
-- Each state change is also logged. This is an AFTER trigger beside the state clock (0061, unchanged): on insert the ticket row must exist before a row can point at it. The row's time is state_changed_at, so a write that sets it keeps its value.
CREATE FUNCTION "tickets_transition_log"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO "ticket_transitions" ("company_id", "ticket_id", "from_state", "to_state", "at") VALUES (NEW.company_id, NEW.id, NULL, NEW.system_state, NEW.state_changed_at);
	ELSIF NEW.system_state IS DISTINCT FROM OLD.system_state THEN
		INSERT INTO "ticket_transitions" ("company_id", "ticket_id", "from_state", "to_state", "at") VALUES (NEW.company_id, NEW.id, OLD.system_state, NEW.system_state, NEW.state_changed_at);
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "tickets_transition_log" AFTER INSERT OR UPDATE ON "tickets" FOR EACH ROW EXECUTE FUNCTION "tickets_transition_log"();
