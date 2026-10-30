CREATE TABLE "provider_quota_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funding_source_id" uuid NOT NULL,
	"used" integer NOT NULL,
	"limit_limit" integer NOT NULL,
	"renews_at" timestamp with time zone,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_quota_warnings" (
	"funding_source_id" uuid NOT NULL,
	"period" text NOT NULL,
	"threshold" integer NOT NULL,
	"warned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_quota_warnings_funding_source_id_period_threshold_pk" PRIMARY KEY("funding_source_id","period","threshold")
);
--> statement-breakpoint
ALTER TABLE "provider_quota_readings" ADD CONSTRAINT "provider_quota_readings_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_quota_warnings" ADD CONSTRAINT "provider_quota_warnings_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_quota_readings_source_time" ON "provider_quota_readings" USING btree ("funding_source_id","taken_at");