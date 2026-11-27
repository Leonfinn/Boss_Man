-- BOS-2669 ticket 1: a saved shortcut is now a page id with the owner's own name for it, if they gave one,
-- rather than a bare id. Early rows wrote bare ids; turn each into {"id": …} so the list is unchanged, only its
-- shape. Nothing is dropped, reordered or renamed, and a list already in the new shape is left exactly as it is.
UPDATE "owner_preferences"
SET "pinned_pages" = COALESCE(
  (
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(item) = 'string' THEN jsonb_build_object('id', item #>> '{}') ELSE item END
      ORDER BY ord
    )
    FROM jsonb_array_elements("pinned_pages") WITH ORDINALITY AS t(item, ord)
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof("pinned_pages") = 'array';
--> statement-breakpoint
