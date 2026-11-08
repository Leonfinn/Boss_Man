ALTER TABLE "mcp_servers" ADD COLUMN "allow_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "allow_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing tool servers keep working when the stricter guard ships (BOS-708): trust the ones whose host was meant for a
-- private address, using the same name rules the server uses without DNS (a private IP literal, or a LAN/stack-style
-- name). A public name added before this deploy stays untrusted, so re-pointing it later can't open the stack network.
UPDATE "mcp_servers" SET "allow_private" = true
FROM (
  -- The userinfo before the host (user@10.0.0.1:8080) is not part of the address, so drop it before reading the host.
  SELECT "id", lower(regexp_replace(split_part(substring("url" from '://(.*)$'), '/', 1), '^.*@', '')) AS raw
  FROM "mcp_servers"
) AS u
WHERE "mcp_servers"."id" = u."id"
  AND (
    (
      -- A private, loopback, link-local or CGNAT IPv4 literal.
      split_part(u."raw", ':', 1) ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' AND (
        split_part(split_part(u."raw", ':', 1), '.', 1)::int IN (0, 10, 127) OR
        (split_part(split_part(u."raw", ':', 1), '.', 1) = '169' AND split_part(split_part(u."raw", ':', 1), '.', 2) = '254') OR
        (split_part(split_part(u."raw", ':', 1), '.', 1) = '172' AND split_part(split_part(u."raw", ':', 1), '.', 2)::int BETWEEN 16 AND 31) OR
        (split_part(split_part(u."raw", ':', 1), '.', 1) = '192' AND split_part(split_part(u."raw", ':', 1), '.', 2) = '168') OR
        (split_part(split_part(u."raw", ':', 1), '.', 1) = '100' AND split_part(split_part(u."raw", ':', 1), '.', 2)::int BETWEEN 64 AND 127)
      )
    ) OR (
      -- A stack or LAN-style name: no dot at all (a container name such as db), or a .local/.internal/.lan/.home/.docker name.
      split_part(u."raw", ':', 1) !~ '\.' OR split_part(u."raw", ':', 1) ~ '\.(local|internal|localhost|lan|home|docker)$'
    )
  );--> statement-breakpoint
-- Every project's git host was trusted for private addresses before this deploy (a LAN git server must keep working), so
-- trust existing ones too (BOS-708). A package imported from now on only gets the trust when its git address was flagged in
-- the preview and the owner ticked, so a re-pointable name in a package can't open the stack network.
UPDATE "projects" SET "allow_private" = true WHERE "repo_url" IS NOT NULL;
