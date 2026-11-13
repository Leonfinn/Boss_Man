CREATE TABLE "owner_chat_traces" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"trace" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_chat_traces" ADD CONSTRAINT "owner_chat_traces_message_id_owner_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."owner_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_chat_traces" ADD CONSTRAINT "owner_chat_traces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_chat_traces" ADD CONSTRAINT "owner_chat_traces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_chat_traces" ADD CONSTRAINT "owner_chat_traces_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_chat_traces_created" ON "owner_chat_traces" USING btree ("created_at");