CREATE TYPE "public"."chat_role" AS ENUM('owner', 'assistant', 'system');--> statement-breakpoint
CREATE TABLE "owner_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"text" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "owner_chat_messages" ADD CONSTRAINT "owner_chat_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_chat_messages" ADD CONSTRAINT "owner_chat_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_chat_company_time" ON "owner_chat_messages" USING btree ("company_id","created_at");