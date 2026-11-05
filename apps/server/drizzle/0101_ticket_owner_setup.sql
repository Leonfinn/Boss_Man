ALTER TABLE "tickets" ADD COLUMN "owner_setup" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "owner_setup_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_owner_setup_decision_id_decisions_id_fk" FOREIGN KEY ("owner_setup_decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;