CREATE TABLE "owner_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"reason" text NOT NULL,
	"commit" text NOT NULL,
	"result" text NOT NULL,
	"ticket_id" uuid,
	"decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_by" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" text,
	"outcome" text,
	"owner_text" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "owner_holds" ADD CONSTRAINT "owner_holds_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_holds" ADD CONSTRAINT "owner_holds_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_holds_one_current" ON "owner_holds" USING btree ("subject") WHERE "owner_holds"."ended_at" is null;