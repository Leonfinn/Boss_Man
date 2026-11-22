ALTER TABLE "wiki_pages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "deleted_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_pages_deleted_at" ON "wiki_pages" USING btree ("deleted_at");