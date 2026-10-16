ALTER TYPE "public"."decision_kind" ADD VALUE 'stalled_run' BEFORE 'engagement';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "last_event_at" timestamp with time zone;