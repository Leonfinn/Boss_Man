CREATE TABLE "watchdog_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid,
	"flag_id" uuid,
	"actor_agent_id" uuid,
	"kind" text NOT NULL,
	"target_agent_id" uuid,
	"reason" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"undoable" boolean DEFAULT false NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchdog_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_flagged_at" timestamp with time zone,
	"flag_count" integer DEFAULT 0 NOT NULL,
	"snoozed_until" timestamp with time zone,
	"snooze_reason" text,
	"snooze_count" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "watchdog" jsonb DEFAULT '{"enabled":false,"unassignedMinutes":15,"inProgressHours":2,"reviewHours":2,"blockedHours":8,"blockedUntilGraceHours":2,"ownerDecisionHours":8,"reviewBounces":2,"maxSnoozeHours":48,"maxSmRunsPerHour":4,"maxNudgesPerHour":12}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "watchdog_tripped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "watchdog_tripped_reason" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "watchdog_last_sweep_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "state_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "blocked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "blocked_until_reason" text;--> statement-breakpoint
ALTER TABLE "watchdog_actions" ADD CONSTRAINT "watchdog_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchdog_actions" ADD CONSTRAINT "watchdog_actions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchdog_actions" ADD CONSTRAINT "watchdog_actions_flag_id_watchdog_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."watchdog_flags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchdog_actions" ADD CONSTRAINT "watchdog_actions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchdog_actions" ADD CONSTRAINT "watchdog_actions_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchdog_flags" ADD CONSTRAINT "watchdog_flags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchdog_flags" ADD CONSTRAINT "watchdog_flags_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watchdog_actions_company_at" ON "watchdog_actions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "watchdog_actions_ticket" ON "watchdog_actions" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchdog_flags_one_open" ON "watchdog_flags" USING btree ("ticket_id","rule") WHERE "watchdog_flags"."status" = 'open';--> statement-breakpoint
CREATE INDEX "watchdog_flags_company" ON "watchdog_flags" USING btree ("company_id","status");--> statement-breakpoint
-- Existing tickets: their last activity is never earlier than their last state change, so the watchdog errs toward fewer alarms on day one.
UPDATE "tickets" SET "state_changed_at" = "last_activity_at";--> statement-breakpoint
-- Every path that changes a ticket's state (scheduler, decisions, loop guards, MCP, owner) gets the clock, and none can leave a stale "blocked until".
-- A write that sets state_changed_at itself keeps its value.
CREATE FUNCTION "tickets_state_clock"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.system_state IS DISTINCT FROM OLD.system_state AND NEW.state_changed_at IS NOT DISTINCT FROM OLD.state_changed_at THEN
		NEW.state_changed_at = now();
	END IF;
	IF NEW.system_state <> 'blocked' THEN
		NEW.blocked_until = NULL;
		NEW.blocked_until_reason = NULL;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "tickets_state_clock" BEFORE INSERT OR UPDATE ON "tickets" FOR EACH ROW EXECUTE FUNCTION "tickets_state_clock"();
