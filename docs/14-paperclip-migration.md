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

2. **Export the issues to `paperclip-issues.json`.** Don't skip this step: the company export holds no issues, so without this file the import brings no tickets, no conversations and no wiki pages, and it doesn't warn you.

   Paperclip's built-in database listens on `127.0.0.1:54329` inside the Paperclip container's network (user and password `paperclip`, database `paperclip`). The standard Paperclip image has no `psql`, so running the query inside that container fails with `sh: 1: psql: not found`. Instead, run `psql` from a throwaway Postgres container that joins the Paperclip container's network. It changes nothing in Paperclip: the session is read-only and the container deletes itself when it ends.

   > **Confirmed on TrueNAS SCALE, 22 Nov 2026.** An owner ran steps a to e there and got `paperclip-issues.json`. Step f (copying the file off the host) is not yet confirmed. If a step fails, note the error and the step letter.

   **You need:** a shell on the machine that runs Paperclip's Docker container, as root or as a user allowed to run `docker` (otherwise put `sudo` in front of each `docker` command). The machine needs internet access the first time, to pull the `postgres:17-alpine` image.

   > **Per-host notes.**
   > - **Plain Linux:** use any shell on the host.
   > - **Proxmox:** run these inside the VM or LXC container where Docker runs, not on the Proxmox host itself.
   > - **TrueNAS SCALE:** use System → Shell (or SSH), and work in a folder on one of your pools.

   a. **Make a working folder and go into it.** Everything below reads and writes files in the current folder.

```sh
mkdir paperclip-export && cd paperclip-export
```

   b. **Find the Paperclip container.**

```sh
docker ps --filter name=paperclip --format '{{.Names}}  {{.Image}}'
```

   This lists running containers with `paperclip` in their name, with their images. If it prints nothing, list every running container and find Paperclip's by its image:

```sh
docker ps --format '{{.Names}}  {{.Image}}'
```

   Pick the Paperclip **app** container (the one running the Paperclip image), not a database container. If your install has a separate database container, such as `paperclip-db` running a `postgres` image, Paperclip uses that database rather than the built-in one: follow "Paperclip uses an external database" below.

   Then put the app container's name into `CONTAINER`, typing it yourself, and check it:

```sh
CONTAINER=paperclip-server-1
echo "$CONTAINER"
```

   Replace `paperclip-server-1` with the name from the list. Don't go on until `echo` prints that name: with an empty name, step d fails.

   c. **Create `paperclip-issues.sql`.** Copy the whole block, from `cat` to the final `SQL` line, and paste it into the shell. The one value to change is `HOL` on the marked line: replace it with your company's issue prefix (the letters before the number in an issue ID such as `HOL-123`), keeping the quotes.

```sh
cat > paperclip-issues.sql <<'SQL'
-- Boss Man: export one Paperclip company's issues, comments and issue documents as one JSON list.
-- Read-only: it only selects.
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
  -- ▼▼▼ CHANGE 'HOL' ON THE NEXT LINE TO YOUR COMPANY'S ISSUE PREFIX ▼▼▼
  WHERE co.issue_prefix = 'HOL' AND i.identifier IS NOT NULL
) x;
SQL
```

   `ls paperclip-issues.sql` should now list the file.

   d. **Run the query from a throwaway Postgres container.** `--network container:"$CONTAINER"` puts it on the Paperclip container's network, so `127.0.0.1:54329` reaches Paperclip's database. `default_transaction_read_only=on` makes the session refuse any write, and `--rm` deletes the container when the query ends. Don't add `-t` to `docker run`: it would mix terminal codes into the JSON.

```sh
docker run --rm -i --network container:"$CONTAINER" \
  -v "$PWD":/work -w /work \
  -e PGPASSWORD=paperclip -e PGOPTIONS='-c default_transaction_read_only=on' \
  postgres:17-alpine \
  psql -At -v ON_ERROR_STOP=1 "postgres://paperclip@127.0.0.1:54329/paperclip" \
  -f paperclip-issues.sql > paperclip-issues.json
```

   e. **Check the result.**

```sh
ls -lh paperclip-issues.json && head -c 300 paperclip-issues.json
```

   The file should start with `[{"identifier":"HOL-` (with your prefix in place of `HOL`). If it shows only `[]`, the prefix in `paperclip-issues.sql` is wrong: fix it in step c and run step d again. If the file is empty, read the error `docker run` printed: `connection refused` usually means the container name in step b is wrong, or Paperclip uses an external database (see below).

   f. **Copy `paperclip-issues.json` to the computer that holds the export folder.** Skip this if it is the same machine as the Docker host.

   > **Not yet confirmed.** This step has not yet been run on an owner's machine.

   You copy the file with `scp`, run from the computer that holds the export folder (on Windows 10 and later, `scp` works in PowerShell). The Docker host needs SSH turned on. SSH usually refuses a `root` login, so log in as an ordinary user, and first put the file in that user's home folder, owned by them. On the Docker host, in the working folder, run this, replacing `alex` with that user's login:

```sh
sudo cp paperclip-issues.json ~alex/
sudo chown alex: ~alex/paperclip-issues.json
```

   (Leave out `sudo` if you are already root.) Then, on the computer that holds the export folder, go into that folder (the one with `COMPANY.md`) and run this, replacing `alex` with the login and `192.168.1.50` with the Docker host's address:

```sh
scp alex@192.168.1.50:paperclip-issues.json .
```

   It asks for that user's password, unless you use an SSH key. `ls paperclip-issues.json` in the export folder should then list the file. If `scp` says `Connection refused`, SSH is off on the Docker host; if it says `Permission denied`, check the login and password, and that the file is in that user's home folder.

   > **Worked example: TrueNAS SCALE.** Turn SSH on in System → Services → SSH. Log in as the admin user `truenas_admin`, not `root`: in the commands above, replace `alex` with `truenas_admin`.

   **Other setups.**
   - **The Paperclip image has `psql`.** Check with `docker exec "$CONTAINER" which psql`. If that prints a path, you can instead copy `paperclip-issues.sql` into the container and run the query there:

```sh
docker cp paperclip-issues.sql "$CONTAINER":/tmp/paperclip-issues.sql
docker exec -i -w /tmp -e PGPASSWORD=paperclip -e PGOPTIONS='-c default_transaction_read_only=on' "$CONTAINER" \
  psql -At -v ON_ERROR_STOP=1 "postgres://paperclip@127.0.0.1:54329/paperclip" \
  -f paperclip-issues.sql > paperclip-issues.json
```

   - **Paperclip uses an external database** (a separate database container such as `paperclip-db`, or its own Postgres server, not the built-in one on `127.0.0.1:54329`). Point `psql` at that database instead: in step d, replace the `postgres://…` address and `PGPASSWORD` with that database's own host, port, user, password and database name, for example `postgres://paperclip@192.168.1.50:5432/paperclip`. If the database is reachable from the host, you can drop `--network container:"$CONTAINER"`.

3. **Put `paperclip-issues.json` next to `COMPANY.md`** in the export folder, then zip the folder.

4. **In Boss Man:** Settings → **Import and export** → pick the zip. Read the preview: the notes say what was left out or renamed. Press **Import as a new company**.

5. **Afterwards**, work through the checklist decision: add each secret and grant it, give agents a funding source, read any skill scripts it lists, then unpause agents one at a time.

**Rotate any secret that ever appeared in a Paperclip run log or issue before adding it to Boss Man.** The issues export carries comments verbatim, so a key pasted into a comment comes across too.
