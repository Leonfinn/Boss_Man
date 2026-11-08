CREATE TABLE "device_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"label" text NOT NULL,
	"browser" text NOT NULL,
	"readings" jsonb NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_profiles" ADD CONSTRAINT "device_profiles_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_profiles_owner_fingerprint" ON "device_profiles" USING btree ("owner_id","fingerprint");--> statement-breakpoint
CREATE INDEX "device_profiles_owner" ON "device_profiles" USING btree ("owner_id");