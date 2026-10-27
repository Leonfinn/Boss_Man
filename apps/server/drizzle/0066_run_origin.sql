ALTER TABLE "runs" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_run_ticket_id_tickets_id_fk" FOREIGN KEY ("run_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;