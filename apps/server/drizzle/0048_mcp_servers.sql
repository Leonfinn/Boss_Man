CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"transport" text NOT NULL,
	"header_name" text DEFAULT 'Authorization' NOT NULL,
	"header_value" text DEFAULT 'Bearer {secret}' NOT NULL,
	"secret_env" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_company_name" ON "mcp_servers" USING btree ("company_id","name");