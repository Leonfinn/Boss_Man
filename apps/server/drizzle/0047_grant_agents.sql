CREATE TABLE "secret_grant_agents" (
	"grant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "secret_grant_agents_grant_id_agent_id_pk" PRIMARY KEY("grant_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "secret_grant_agents" ADD CONSTRAINT "secret_grant_agents_grant_id_secret_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."secret_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_grant_agents" ADD CONSTRAINT "secret_grant_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;