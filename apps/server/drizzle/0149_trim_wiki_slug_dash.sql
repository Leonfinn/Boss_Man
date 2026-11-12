-- BOS-1324: a long title used to make a slug ending in "-" (cut to 80 after the ends were trimmed), and a
-- write to that slug was tidied to the slug without the "-", so DR-058 ended up as two pages. slugify now
-- trims after the cut; this moves each page whose slug has a part ending in "-" to the address without it.
-- Where a page is already there, the two are merged: the newer text wins, the other page's versions join
-- the kept page's history (so nothing is lost and restore can bring it back), and the "-" page goes.
-- Each move or merge leaves a 'wiki_slug_fix' activity row naming both addresses.
CREATE TEMP TABLE "bos1324_dash_pages" AS
SELECT d."id" AS "dash_id", d."company_id", d."slug" AS "dash_slug", d."updated_at" AS "dash_at",
  regexp_replace(d."slug", '-+(/|$)', '\1', 'g') AS "clean_slug",
  NULL::uuid AS "keep_id", NULL::timestamptz AS "keep_at"
FROM "wiki_pages" d
WHERE d."slug" ~ '-(/|$)';
--> statement-breakpoint
-- Never make an empty part; and when two "-" pages tidy to the same address, move only the newest
-- (the others stay where they are, still readable by their exact slug).
DELETE FROM "bos1324_dash_pages" x
WHERE x."clean_slug" ~ '(^|/)(/|$)'
  OR EXISTS (
    SELECT 1 FROM "bos1324_dash_pages" y
    WHERE y."company_id" = x."company_id" AND y."clean_slug" = x."clean_slug" AND (y."dash_at", y."dash_id") > (x."dash_at", x."dash_id")
  );
--> statement-breakpoint
UPDATE "bos1324_dash_pages" x
SET "keep_id" = k."id", "keep_at" = k."updated_at"
FROM "wiki_pages" k
WHERE k."company_id" = x."company_id" AND k."slug" = x."clean_slug";
--> statement-breakpoint
INSERT INTO "activity" ("company_id", "kind", "summary", "detail")
SELECT x."company_id", 'wiki_slug_fix',
  CASE
    WHEN x."keep_id" IS NULL THEN 'Wiki page "' || x."dash_slug" || '" moved to "' || x."clean_slug" || '" (its slug ended in "-", BOS-1324).'
    WHEN x."dash_at" > x."keep_at" THEN 'Wiki page "' || x."dash_slug" || '" merged into "' || x."clean_slug" || '": its text was newer and is now that page''s; the older text is in the page''s history (BOS-1324).'
    ELSE 'Wiki page "' || x."dash_slug" || '" merged into "' || x."clean_slug" || '", which was newer and keeps its text; the "-" page''s versions are in its history (BOS-1324).'
  END,
  jsonb_build_object('from', x."dash_slug", 'to', x."clean_slug", 'pageId', coalesce(x."keep_id", x."dash_id"), 'kept', CASE WHEN x."keep_id" IS NULL THEN 'moved' WHEN x."dash_at" > x."keep_at" THEN 'dash' ELSE 'clean' END)
FROM "bos1324_dash_pages" x;
--> statement-breakpoint
-- The "-" page is newer: its text becomes the kept page's (the kept page keeps its own folder and ticket).
UPDATE "wiki_pages" k
SET "title" = d."title", "body" = d."body", "updated_by_agent_id" = d."updated_by_agent_id", "updated_at" = d."updated_at"
FROM "bos1324_dash_pages" x
JOIN "wiki_pages" d ON d."id" = x."dash_id"
WHERE k."id" = x."keep_id" AND x."dash_at" > x."keep_at";
--> statement-breakpoint
UPDATE "wiki_revisions" r
SET "page_id" = x."keep_id"
FROM "bos1324_dash_pages" x
WHERE r."page_id" = x."dash_id" AND x."keep_id" IS NOT NULL;
--> statement-breakpoint
-- A ticket that produced the "-" page's winning text now lists the kept page. When the "-" page lost, its
-- ticket links go with it (that text is only in history now).
UPDATE "ticket_artifacts" a
SET "wiki_page_id" = x."keep_id"
FROM "bos1324_dash_pages" x
WHERE a."wiki_page_id" = x."dash_id" AND x."keep_id" IS NOT NULL AND x."dash_at" > x."keep_at"
  AND NOT EXISTS (SELECT 1 FROM "ticket_artifacts" b WHERE b."ticket_id" = a."ticket_id" AND b."wiki_page_id" = x."keep_id");
--> statement-breakpoint
DELETE FROM "wiki_pages" p
USING "bos1324_dash_pages" x
WHERE p."id" = x."dash_id" AND x."keep_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "wiki_pages" p
SET "slug" = x."clean_slug"
FROM "bos1324_dash_pages" x
WHERE p."id" = x."dash_id" AND x."keep_id" IS NULL;
--> statement-breakpoint
-- contract-ok: drops only this migration's own TEMP scratch table, no real data
DROP TABLE "bos1324_dash_pages";
