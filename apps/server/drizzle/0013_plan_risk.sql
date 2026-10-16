CREATE TYPE "public"."risk_tier" AS ENUM('trivial', 'low', 'medium', 'high', 'critical');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deep_verify_command" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "risk" "risk_tier";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "plan_first" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "plan_approved_at" timestamp with time zone;