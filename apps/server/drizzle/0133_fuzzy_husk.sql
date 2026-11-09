ALTER TABLE "features" ADD COLUMN "keep_off_portal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- BOS-957: existing open features follow the new "on the portal unless sensitive/security" default once. This only turns
-- features ON; it never turns any off and never touches one marked "keep off the portal (sensitive)". It mirrors the shared
-- portalVerdict/looksLikeSecurity keyword rule. A feature still only reaches visitors once it has a public summary (the
-- portal shows the internal title and description), so this cannot expose internal text on its own.
UPDATE "features" SET "portal_visible" = true
WHERE "portal_visible" = false
  AND "keep_off_portal" = false
  AND "status" IN ('idea', 'considering', 'planned', 'in_progress')
  AND NOT (
    lower(concat_ws(' ', "title", coalesce("description", ''), (
      SELECT coalesce(string_agg("name", ' '), '') FROM "feature_areas" WHERE "feature_areas"."id" = "features"."area_id"
    ))) ~ '\y(security|secure|permission|permissions|credential|credentials|secret|secrets|token|tokens|password|passwords|vulnerability|vulnerable|exploit|auth|authentication|authorisation|authorization|sandbox|firewall|encrypt|encryption|decrypt|crypto|cryptography|ssh|ssl|tls|certificate|certificates|privilege|privileges|sudo|acl)\y'
    OR lower(concat_ws(' ', "title", coalesce("description", ''))) ~ '(access control|api key|private key|network guard|agent fence|key rotation|role based)'
  );