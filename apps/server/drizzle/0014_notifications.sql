CREATE TYPE "public"."notify_level" AS ENUM('note', 'flag', 'page', 'ask');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"agent_id" uuid,
	"requested" "notify_level" NOT NULL,
	"level" "notify_level" NOT NULL,
	"demoted_by" text,
	"title" text NOT NULL,
	"body" text,
	"link" text NOT NULL,
	"decision_id" uuid,
	"pushed_at" timestamp with time zone,
	"push_error" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_decision_id_unique" UNIQUE("decision_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_agent_time" ON "notifications" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_time" ON "notifications" USING btree ("created_at");