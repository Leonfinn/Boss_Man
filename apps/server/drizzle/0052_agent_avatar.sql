CREATE TABLE "agent_avatars" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"type" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "avatar_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_avatars" ADD CONSTRAINT "agent_avatars_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;