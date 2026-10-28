ALTER TABLE "workflow_changes" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_changes" ADD COLUMN "check_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_changes" ADD CONSTRAINT "workflow_changes_check_decision_id_decisions_id_fk" FOREIGN KEY ("check_decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;