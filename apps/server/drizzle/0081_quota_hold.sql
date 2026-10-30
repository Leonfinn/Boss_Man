CREATE TYPE "public"."quota_overage_mode" AS ENUM('pause', 'urgent', 'all');--> statement-breakpoint
ALTER TABLE "funding_sources" ADD COLUMN "quota_hold_at" real DEFAULT 0.95 NOT NULL;--> statement-breakpoint
ALTER TABLE "funding_sources" ADD COLUMN "quota_overage" "quota_overage_mode" DEFAULT 'pause' NOT NULL;--> statement-breakpoint
ALTER TABLE "funding_sources" ADD COLUMN "quota_disabled_windows" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "funding_sources" ADD COLUMN "quota_held_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "funding_sources" ADD COLUMN "quota_overage_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;