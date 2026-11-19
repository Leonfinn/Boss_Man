ALTER TABLE "tickets" ADD COLUMN "report_in_chat_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "report_in_chat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "chat_report_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_report_in_chat_agent_id_agents_id_fk" FOREIGN KEY ("report_in_chat_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;