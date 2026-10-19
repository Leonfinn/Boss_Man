CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "wiki_section_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"section_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_semantic_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"base_url" text DEFAULT 'https://openrouter.ai/api/v1' NOT NULL,
	"model" text DEFAULT 'google/gemini-embedding-001' NOT NULL,
	"dims" integer DEFAULT 768 NOT NULL,
	"secret_id" uuid
);
--> statement-breakpoint
ALTER TABLE "wiki_section_embeddings" ADD CONSTRAINT "wiki_section_embeddings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_embeddings" ADD CONSTRAINT "wiki_section_embeddings_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_semantic_settings" ADD CONSTRAINT "wiki_semantic_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_semantic_settings" ADD CONSTRAINT "wiki_semantic_settings_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_section_embeddings_page_path" ON "wiki_section_embeddings" USING btree ("page_id","section_path");--> statement-breakpoint
CREATE INDEX "wiki_section_embeddings_company" ON "wiki_section_embeddings" USING btree ("company_id");