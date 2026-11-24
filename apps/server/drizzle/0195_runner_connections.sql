CREATE TABLE "runner_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dropped_at" timestamp with time zone,
	"ended_how" text
);
--> statement-breakpoint
ALTER TABLE "runner_connections" ADD CONSTRAINT "runner_connections_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_connections_runner_connected" ON "runner_connections" USING btree ("runner_id","connected_at");