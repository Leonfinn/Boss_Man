CREATE TYPE "public"."wake_status" AS ENUM('queued', 'deferred', 'launched', 'dropped');--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"ticket_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"priority" integer DEFAULT 2 NOT NULL,
	"causation_depth" integer DEFAULT 0 NOT NULL,
	"caused_by_run_id" uuid,
	"caused_by_agent_id" uuid,
	"status" "wake_status" DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"not_before" timestamp with time zone,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wakes_status_priority" ON "wakes" USING btree ("status","priority");