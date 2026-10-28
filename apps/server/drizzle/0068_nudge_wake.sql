ALTER TABLE "nudges" ADD COLUMN "wake_id" uuid;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_wake_id_wakes_id_fk" FOREIGN KEY ("wake_id") REFERENCES "public"."wakes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wakes_run_id" ON "wakes" USING btree ("run_id");