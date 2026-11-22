CREATE TABLE "permission_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid,
	"ticket_id" uuid,
	"title" text,
	"kind" text,
	"rule" text NOT NULL,
	"position" integer NOT NULL,
	"outcome" text NOT NULL,
	"tier" text NOT NULL,
	"decision_id" uuid,
	"answered_by" text,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "permission_decisions_run" ON "permission_decisions" USING btree ("run_id","at");--> statement-breakpoint
CREATE INDEX "permission_decisions_at" ON "permission_decisions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "permission_decisions_card" ON "permission_decisions" USING btree ("decision_id");