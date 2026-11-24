CREATE TABLE "key_result_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_result_id" uuid NOT NULL,
	"value" real NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_kind" text NOT NULL,
	"agent_id" uuid
);
--> statement-breakpoint
ALTER TABLE "key_result_readings" ADD CONSTRAINT "key_result_readings_key_result_id_key_results_id_fk" FOREIGN KEY ("key_result_id") REFERENCES "public"."key_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_result_readings" ADD CONSTRAINT "key_result_readings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "key_result_readings_kr_at" ON "key_result_readings" USING btree ("key_result_id","at");