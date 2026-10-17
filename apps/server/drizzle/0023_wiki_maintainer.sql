ALTER TABLE "agents" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "duty" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_duty_per_company" ON "agents" USING btree ("company_id","duty") WHERE "agents"."duty" is not null;--> statement-breakpoint
-- Every company gets a wiki maintainer, paused until the owner gives it a model and starts it.
INSERT INTO "agents" ("company_id", "name", "role", "agent_kind", "paused", "duty") SELECT "id", 'Wiki Maintainer', 'worker', 'claude', true, 'wiki' FROM "companies";
