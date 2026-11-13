ALTER TABLE "decisions" ADD COLUMN "recheck_stage" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "recheck_stage_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "rechecked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "rechecked_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "recheck_note" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "recheck_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_rechecked_by_agent_id_agents_id_fk" FOREIGN KEY ("rechecked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;