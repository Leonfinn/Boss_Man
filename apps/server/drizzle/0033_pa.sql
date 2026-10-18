CREATE TABLE "pa_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_message_id" uuid NOT NULL,
	"question" text NOT NULL,
	"reply" text,
	"cites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"sampled" boolean DEFAULT false NOT NULL,
	"ceo_message_id" uuid,
	"ceo_replied_at" timestamp with time zone,
	"verdict" text,
	"verdict_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "agents_one_duty_per_company";--> statement-breakpoint
ALTER TABLE "pa_answers" ADD CONSTRAINT "pa_answers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_answers" ADD CONSTRAINT "pa_answers_chat_message_id_owner_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."owner_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_answers" ADD CONSTRAINT "pa_answers_ceo_message_id_owner_chat_messages_id_fk" FOREIGN KEY ("ceo_message_id") REFERENCES "public"."owner_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pa_answers_one_per_message" ON "pa_answers" USING btree ("chat_message_id");--> statement-breakpoint
CREATE INDEX "pa_answers_company_time" ON "pa_answers" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_duty_per_company" ON "agents" USING btree ("company_id","duty") WHERE "agents"."duty" is not null and "agents"."retired_at" is null;