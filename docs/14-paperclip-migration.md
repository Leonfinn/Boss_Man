# 14 — Moving a company from Paperclip

Boss Man imports a Paperclip company in one step: its company export plus one JSON file of issues. Nothing in Paperclip is changed. The import is the general one (docs/11), so the preview, the checks and the "every agent starts paused" rule all apply.

## What comes across

| Paperclip | Boss Man |
|---|---|
| Company, agents, their instructions, models and who they report to | the same, paused (docs/11, Agent Companies adapter) |
| Skills | the company's skill library; Paperclip's own API skills are left out |
| Secret inputs (`kind: secret`) | **names only**: the checklist says which secret to add and who gets it |
| Projects | projects, with the repo from the primary workspace |
| Issues | tickets, keeping their state, parent and creation time; the body ends with `Imported from HOL-123` so the old ID still finds it |
| Comments | the ticket's conversation; an agent's comment stays theirs, the rest show as yours or as system notes |
| Issue documents (`plan`, `spec`, `claims`, …) | wiki pages under **Imported/HOL-123**, linked to the ticket. A document over 190,000 characters is split into parts |
| `continuation-summary` documents | skipped: they were Paperclip's notes between runs |

Paperclip's `cancelled` has no Boss Man state, so those tickets arrive as done with the outcome "Cancelled in Paperclip.". Priorities, run history, costs and heartbeats don't come across.

## Steps

1. **Export the company from Paperclip.** Its company export gives a folder with `COMPANY.md`, `.paperclip.yaml`, `agents/`, `projects/` and `skills/`.

2. **Export the issues** with the read-only query below. Paperclip's built-in database listens on `127.0.0.1:54329` (user and password `paperclip`, database `paperclip`), so run it wherever `psql` can reach that address, usually inside the Paperclip container. Change `'HOL'` to your company's issue prefix. `default_transaction_read_only=on` makes the session refuse any write.

```sh
PGPASSWORD=paperclip PGOPTIONS='-c default_transaction_read_only=on' psql -At -v ON_ERROR_STOP=1 \
  "postgres://paperclip@127.0.0.1:54329/paperclip" \
  -f paperclip-issues.sql > paperclip-issues.json
```

   `paperclip-issues.sql`:

```sql
-- Boss Man: export one Paperclip company's issues, comments and issue documents as one JSON list.
-- Read-only: it only selects. Change 'HOL' to your company's issue prefix.
SELECT coalesce(json_agg(x ORDER BY x.created_at), '[]'::json)
FROM (
  SELECT
    i.identifier,
    i.title,
    i.status,
    i.priority,
    parent.identifier AS parent,
    p.name AS project,
    i.description,
    i.created_at,
    i.completed_at,
    (SELECT coalesce(json_agg(json_build_object('at', c.created_at, 'by', coalesce(a.name, c.author_user_id, c.author_type, 'owner'), 'body', c.body) ORDER BY c.created_at), '[]'::json)
       FROM issue_comments c LEFT JOIN agents a ON a.id = c.author_agent_id
      WHERE c.issue_id = i.id AND c.deleted_at IS NULL) AS comments,
    (SELECT coalesce(json_agg(json_build_object('key', d.key, 'title', doc.title, 'body', doc.latest_body) ORDER BY d.key), '[]'::json)
       FROM issue_documents d JOIN documents doc ON doc.id = d.document_id
      WHERE d.issue_id = i.id) AS documents
  FROM issues i
  JOIN companies co ON co.id = i.company_id
  LEFT JOIN issues parent ON parent.id = i.parent_id
  LEFT JOIN projects p ON p.id = i.project_id
  WHERE co.issue_prefix = 'HOL' AND i.identifier IS NOT NULL
) x;
```

3. **Put `paperclip-issues.json` next to `COMPANY.md`** in the export folder, then zip the folder.

4. **In Boss Man:** Settings → **Import and export** → pick the zip. Read the preview: the notes say what was left out or renamed. Press **Import as a new company**.

5. **Afterwards**, work through the checklist decision: add each secret and grant it, give agents a funding source, read any skill scripts it lists, then unpause agents one at a time.

**Rotate any secret that ever appeared in a Paperclip run log or issue before adding it to Boss Man.** The issues export carries comments verbatim, so a key pasted into a comment comes across too.
