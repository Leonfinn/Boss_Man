ALTER TABLE "owner_chat_messages" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "owner_chat_messages" ADD CONSTRAINT "owner_chat_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_chat_agent_time" ON "owner_chat_messages" USING btree ("agent_id","created_at");--> statement-breakpoint
-- Conversations so far were all with the CEO.
UPDATE "owner_chat_messages" m SET "agent_id" = a."id" FROM "agents" a WHERE a."company_id" = m."company_id" AND a."role" = 'ceo' AND m."agent_id" IS NULL;
