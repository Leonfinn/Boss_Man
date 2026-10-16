CREATE TABLE "ceo_chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"directive" text NOT NULL,
	"handoff_in" text,
	"acp_session_id" text,
	"context_used" integer,
	"context_size" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"roll_requested_at" timestamp with time zone,
	"closing_run_id" uuid,
	"end_reason" text,
	"handoff" text,
	"handoff_by" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "chapter_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "context_used" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "context_size" integer;--> statement-breakpoint
ALTER TABLE "ceo_chapters" ADD CONSTRAINT "ceo_chapters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceo_chapters" ADD CONSTRAINT "ceo_chapters_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ceo_chapters_agent_number" ON "ceo_chapters" USING btree ("agent_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "ceo_chapters_one_open" ON "ceo_chapters" USING btree ("agent_id") WHERE "ceo_chapters"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_chapter_id_ceo_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."ceo_chapters"("id") ON DELETE set null ON UPDATE no action;