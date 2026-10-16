ALTER TABLE "tickets" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "resume_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;