CREATE TABLE "funding_quota_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funding_source_id" uuid NOT NULL,
	"window" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "funding_window_summaries" (
	"funding_source_id" uuid NOT NULL,
	"window" text NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	"peak_utilization" real NOT NULL,
	"limit_value" integer,
	CONSTRAINT "funding_window_summaries_funding_source_id_window_resets_at_pk" PRIMARY KEY("funding_source_id","window","resets_at")
);
--> statement-breakpoint
ALTER TABLE "funding_quota_holds" ADD CONSTRAINT "funding_quota_holds_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_window_summaries" ADD CONSTRAINT "funding_window_summaries_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funding_quota_holds_source_time" ON "funding_quota_holds" USING btree ("funding_source_id","started_at");
--> statement-breakpoint
-- Fill the first rows from the readings still on hand (up to 30 days); the Synthetic hold samples carry made-up reset times, so they are left out.
INSERT INTO "funding_window_summaries" ("funding_source_id", "window", "resets_at", "peak_utilization")
SELECT "funding_source_id", "window", date_trunc('hour', "resets_at" + interval '30 minutes'), max("utilization")
FROM "quota_samples"
WHERE "resets_at" IS NOT NULL AND "window" NOT LIKE 'synthetic\_%'
GROUP BY 1, 2, 3;
