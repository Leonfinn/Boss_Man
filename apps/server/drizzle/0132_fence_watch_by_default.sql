ALTER TABLE "companies" ALTER COLUMN "fence_mode" SET DEFAULT 'watch';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "fence_mode_chosen_at" timestamp with time zone;--> statement-breakpoint
-- BOS-940: the old default was off, so a company already at watch or enforce chose it. Mark it chosen so Boss Man never changes it. No fence_mode is changed here (DR-041).
UPDATE "companies" SET "fence_mode_chosen_at" = now() WHERE "fence_mode" <> 'off';
