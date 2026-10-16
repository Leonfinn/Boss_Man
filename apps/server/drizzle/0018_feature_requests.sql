CREATE TYPE "public"."feature_status" AS ENUM('idea', 'considering', 'planned', 'in_progress', 'released', 'declined');--> statement-breakpoint
CREATE TYPE "public"."importance" AS ENUM('nice_to_have', 'important', 'critical');--> statement-breakpoint
CREATE TYPE "public"."note_source" AS ENUM('owner', 'chat', 'agent', 'portal', 'email', 'import');--> statement-breakpoint
CREATE TYPE "public"."note_state" AS ENUM('unprocessed', 'processed', 'archived');--> statement-breakpoint
CREATE TABLE "feature_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"area_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "feature_status" DEFAULT 'idea' NOT NULL,
	"effort" integer,
	"driver_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"milestone_id" uuid,
	"portal_visible" boolean DEFAULT false NOT NULL,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feedback_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"segment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text,
	"text" text NOT NULL,
	"source" "note_source" DEFAULT 'owner' NOT NULL,
	"customer_id" uuid,
	"state" "note_state" DEFAULT 'unprocessed' NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"created_by_agent_id" uuid,
	"portal_voter" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feedback_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"demand_weight" integer DEFAULT 3 NOT NULL,
	"ceo_triage" boolean DEFAULT false NOT NULL,
	"portal_enabled" boolean DEFAULT false NOT NULL,
	"portal_token" text,
	"portal_title" text,
	"portal_intro" text,
	CONSTRAINT "feedback_settings_portal_token_unique" UNIQUE("portal_token")
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"importance" "importance" DEFAULT 'important' NOT NULL,
	"highlight" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "feature_id" uuid;--> statement-breakpoint
ALTER TABLE "feature_areas" ADD CONSTRAINT "feature_areas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_drivers" ADD CONSTRAINT "feature_drivers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_area_id_feature_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."feature_areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_parent_id_features_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_customers" ADD CONSTRAINT "feedback_customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_customer_id_feedback_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."feedback_customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_settings" ADD CONSTRAINT "feedback_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_note_id_feedback_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."feedback_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "features_company" ON "features" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_customers_name" ON "feedback_customers" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "feedback_notes_company_state" ON "feedback_notes" USING btree ("company_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_note_feature" ON "insights" USING btree ("note_id","feature_id");--> statement-breakpoint
CREATE INDEX "insights_feature" ON "insights" USING btree ("feature_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE set null ON UPDATE no action;