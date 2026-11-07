CREATE TABLE "runner_event_attempts" (
	"runner_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "runner_event_attempts_runner_id_seq_pk" PRIMARY KEY("runner_id","seq")
);
--> statement-breakpoint
ALTER TABLE "runner_event_attempts" ADD CONSTRAINT "runner_event_attempts_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;