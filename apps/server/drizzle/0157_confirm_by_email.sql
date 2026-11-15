CREATE TABLE "portal_confirmed_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD COLUMN "confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD COLUMN "confirm_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD COLUMN "confirm_email" text;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD COLUMN "confirm_name" text;--> statement-breakpoint
ALTER TABLE "feedback_settings" ADD COLUMN "confirm_by_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_settings" ADD COLUMN "confirm_link_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_settings" ADD COLUMN "remember_address_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_confirmed_addresses" ADD CONSTRAINT "portal_confirmed_addresses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_confirmed_secret" ON "portal_confirmed_addresses" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "portal_confirmed_expires" ON "portal_confirmed_addresses" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_notes_confirm_token" ON "feedback_notes" USING btree ("confirm_token_hash");