CREATE TABLE "meaning_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"text_hash" text NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_semantic_settings" ADD COLUMN "ticket_meaning" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meaning_embeddings" ADD CONSTRAINT "meaning_embeddings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meaning_embeddings_source" ON "meaning_embeddings" USING btree ("kind","source_id");--> statement-breakpoint
CREATE INDEX "meaning_embeddings_company" ON "meaning_embeddings" USING btree ("company_id");