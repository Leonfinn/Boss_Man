ALTER TABLE "policy_rules" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "source_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_source_decision_id_decisions_id_fk" FOREIGN KEY ("source_decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;
