CREATE TABLE "owner_preferences" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"single_letter_keys" boolean DEFAULT true NOT NULL,
	"pinned_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_preferences" ADD CONSTRAINT "owner_preferences_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;