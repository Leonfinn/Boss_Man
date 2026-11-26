CREATE TABLE "ticket_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"touches_runner" boolean,
	"touches_runner_update" boolean,
	"deploys_nothing" boolean
);
--> statement-breakpoint
ALTER TABLE "ticket_merges" ADD CONSTRAINT "ticket_merges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_merges" ADD CONSTRAINT "ticket_merges_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_merges_ticket_commit" ON "ticket_merges" USING btree ("ticket_id","commit");--> statement-breakpoint
CREATE INDEX "ticket_merges_company" ON "ticket_merges" USING btree ("company_id","merged_at");--> statement-breakpoint
-- BOS-2653 backfill: each ticket's recorded (latest) merge, with its runner facts.
INSERT INTO "ticket_merges" ("company_id", "ticket_id", "commit", "merged_at", "touches_runner", "touches_runner_update", "deploys_nothing")
SELECT "company_id", "id", lower("merge_commit"), coalesce("merged_at", "state_changed_at"), "touches_runner", "touches_runner_update", "deploys_nothing"
FROM "tickets" WHERE "merge_commit" IS NOT NULL
ON CONFLICT ("ticket_id", "commit") DO NOTHING;--> statement-breakpoint
-- Earlier merges a later merge of the same ticket overwrote: the merge line's "merged" rows. Their files weren't kept, so
-- the runner facts stay null (not known), which the runner-update answer counts as "can't tell", never as server-only.
INSERT INTO "ticket_merges" ("company_id", "ticket_id", "commit", "merged_at")
SELECT DISTINCT ON ("ticket_id", lower("detail"->>'commit')) "company_id", "ticket_id", lower("detail"->>'commit'), "at"
FROM "activity"
WHERE "kind" = 'merge_line' AND "ticket_id" IS NOT NULL AND "detail"->>'event' = 'merged' AND ("detail"->>'commit') ~* '^[0-9a-f]{40}$'
ORDER BY "ticket_id", lower("detail"->>'commit'), "at"
ON CONFLICT ("ticket_id", "commit") DO NOTHING;