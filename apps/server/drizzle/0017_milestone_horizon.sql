CREATE TYPE "public"."roadmap_horizon" AS ENUM('now', 'next', 'later');--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "horizon" "roadmap_horizon";