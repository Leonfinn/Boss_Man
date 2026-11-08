ALTER TABLE "projects" ADD COLUMN "allow_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Every project's git host was trusted for private addresses before this deploy (a LAN git server must keep working), so
-- trust existing ones too (BOS-708). A package imported from now on only gets the trust when its git address was flagged in
-- the preview and the owner ticked, so a re-pointable name in a package can't open the stack network.
UPDATE "projects" SET "allow_private" = true WHERE "repo_url" IS NOT NULL;
