CREATE TABLE "check_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"company_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slots" integer DEFAULT 1 NOT NULL,
	"check_threads" integer,
	"check_memory_mb" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"image_commit" text,
	"image_version" text,
	"reported_slots" integer,
	"features" jsonb,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_workers_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "check_jobs" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "check_jobs" ADD CONSTRAINT "check_jobs_worker_id_check_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."check_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_jobs_worker_state" ON "check_jobs" USING btree ("worker_id","state");