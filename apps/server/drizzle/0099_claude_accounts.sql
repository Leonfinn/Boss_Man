ALTER TABLE "funding_sources" ADD COLUMN "fallback_rank" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "funding_source_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE set null ON UPDATE no action;
