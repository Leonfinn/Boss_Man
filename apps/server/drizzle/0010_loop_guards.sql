ALTER TYPE "public"."budget_scope" ADD VALUE 'instance';--> statement-breakpoint
CREATE TABLE "failure_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid,
	"agent_id" uuid,
	"signature" text NOT NULL,
	"sample" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"reviewer" text NOT NULL,
	"verdict" text NOT NULL,
	"comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ticket_cost_cap_micros" bigint;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "cost_cap_micros" bigint;--> statement-breakpoint
ALTER TABLE "failure_signatures" ADD CONSTRAINT "failure_signatures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_signatures" ADD CONSTRAINT "failure_signatures_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_signatures" ADD CONSTRAINT "failure_signatures_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reviews" ADD CONSTRAINT "ticket_reviews_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "failure_signatures_lookup" ON "failure_signatures" USING btree ("ticket_id","signature","created_at");