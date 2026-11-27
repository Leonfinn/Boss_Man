CREATE TABLE "check_ticket_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_ticket_id" uuid NOT NULL,
	"own_criterion" integer NOT NULL,
	"ticket_id" uuid NOT NULL,
	"criterion" integer NOT NULL,
	"appended" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_ticket_links" ADD CONSTRAINT "check_ticket_links_check_ticket_id_tickets_id_fk" FOREIGN KEY ("check_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ticket_links" ADD CONSTRAINT "check_ticket_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_ticket_links_check" ON "check_ticket_links" USING btree ("check_ticket_id");--> statement-breakpoint
CREATE INDEX "check_ticket_links_ticket" ON "check_ticket_links" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "check_ticket_links_one" ON "check_ticket_links" USING btree ("check_ticket_id","ticket_id","criterion");