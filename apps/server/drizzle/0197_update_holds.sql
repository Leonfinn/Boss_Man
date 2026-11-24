CREATE TABLE "update_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"deadline" timestamp with time zone,
	"minutes" integer,
	"swap_tries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ended_at" timestamp with time zone,
	"end_ok" boolean,
	"end_title" text,
	"end_body" text,
	"final_state" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "update_holds_started" ON "update_holds" USING btree ("started_at");