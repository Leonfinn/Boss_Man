CREATE TABLE "check_job_logs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"log" text NOT NULL,
	"chars" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_job_logs" ADD CONSTRAINT "check_job_logs_job_id_check_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."check_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_job_logs_created" ON "check_job_logs" USING btree ("created_at");