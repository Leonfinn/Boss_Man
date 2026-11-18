ALTER TABLE "tickets" ADD COLUMN "checks_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "checks_criterion" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_checks_ticket_id_tickets_id_fk" FOREIGN KEY ("checks_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;