CREATE TABLE "approve_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"token_hash" text NOT NULL,
	"decision_rev" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "approve_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "phone_action_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"company_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approve_tokens" ADD CONSTRAINT "approve_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approve_tokens" ADD CONSTRAINT "approve_tokens_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_action_hits" ADD CONSTRAINT "phone_action_hits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approve_tokens_live" ON "approve_tokens" USING btree ("decision_id") WHERE "approve_tokens"."used_at" is null and "approve_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "approve_tokens_company_expires" ON "approve_tokens" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "phone_action_hits_ip_at" ON "phone_action_hits" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "phone_action_hits_company_at" ON "phone_action_hits" USING btree ("company_id","at");