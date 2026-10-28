ALTER TABLE "nudges" ADD COLUMN "wake_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_wake_id_wakes_id_fk" FOREIGN KEY ("wake_id") REFERENCES "public"."wakes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_run_ticket_id_tickets_id_fk" FOREIGN KEY ("run_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wakes_run_id" ON "wakes" USING btree ("run_id");