ALTER TABLE "tickets" ADD COLUMN "watcher_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "watch_every_minutes" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "watched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_watcher_agent_id_agents_id_fk" FOREIGN KEY ("watcher_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;