---
title: Moving a company from Paperclip
navTitle: Coming from Paperclip
description: Bring a Paperclip company into Boss Man in one import: its agents, skills and projects from the company export, and its issues, comments and documents from one extra read-only query.
group: Start here
order: 3
lead: This guide moves a company from Paperclip into Boss Man in one import. You need two things from Paperclip, the company export and one file of issues, and nothing in Paperclip is changed.
time: About 20 minutes. You need a shell on the machine that runs Paperclip's Docker container, and a Boss Man owner login.
---

This page is for you if you run a company in Paperclip and want to carry on with it in Boss Man. The full reference is [`docs/14-paperclip-migration.md`](@repo/blob/main/docs/14-paperclip-migration.md) in the repository. This guide follows it step for step.

The import is Boss Man's general company import, so its preview, its checks and its rule that every agent starts paused all apply.

:::note Don't skip step 2
Paperclip's own company export does **not** contain your issues, their comments or their documents (the documents become your wiki pages). You have to export them yourself with one extra read-only query (step 2), and put that file next to `COMPANY.md` before you zip the folder (steps 3 and 4).

Without it, the import brings no tickets, no conversations and no wiki pages, and it does not warn you.
:::

## What comes across

| Paperclip | Boss Man |
|---|---|
| Company, agents, their instructions, models and who they report to | the same, with every agent paused |
| Skills | the company's skill library. Paperclip's own API skills are left out |
| Secret inputs (`kind: secret`) | **names only**: the checklist says which secret to add and who gets it |
| Projects | projects, with the repo from the primary workspace |
| Issues | tickets, keeping their state, parent and creation time. The body ends with `Imported from HOL-123`, so the old ID still finds it |
| Comments | the ticket's conversation. An agent's comment stays theirs, the rest show as yours or as system notes |
| Issue documents (`plan`, `spec`, `claims` and others) | wiki pages under **Imported/HOL-123**, linked to the ticket. A document over 190,000 characters is split into parts |
| `continuation-summary` documents | skipped: they were Paperclip's notes between runs |

Paperclip's `cancelled` has no Boss Man state, so those tickets arrive as done with the outcome "Cancelled in Paperclip.".

These do not come across: priorities, run history, costs and heartbeats.

## Before you start

:::note You need
- a shell on the machine that runs Paperclip's Docker container, as root or as a user allowed to run `docker`. Otherwise put `sudo` in front of each `docker` command.
- internet access on that machine the first time, to download the `postgres:17-alpine` image
- your company's issue prefix: the letters before the number in an issue ID, such as `HOL` in `HOL-123`
- a running Boss Man and its owner login. If you have not installed it yet, start with [Install Boss Man](/guides/install-boss-man).
:::

Where to open the shell:

- **Plain Linux:** any shell on the host.
- **Proxmox:** inside the VM or LXC container where Docker runs, not on the Proxmox host itself.
- **TrueNAS SCALE:** System → Shell (or SSH). Work in a folder on one of your pools.

## 1. Export the company from Paperclip

Use Paperclip's company export. It gives a folder with `COMPANY.md`, `.paperclip.yaml`, `agents/`, `projects/` and `skills/`.

This folder does not hold your issues. Step 2 gets them.

## 2. Export the issues to paperclip-issues.json

This step makes the file that carries your issues, comments and documents. Don't skip it.

Paperclip's built-in database listens on `127.0.0.1:54329` inside the Paperclip container's network. The user and password are both `paperclip`, and the database is `paperclip`. The standard Paperclip image has no `psql`, so running the query inside that container fails with `sh: 1: psql: not found`.

Instead, you run `psql` from a throwaway Postgres container that joins the Paperclip container's network. It changes nothing in Paperclip: the session is read-only, and the container deletes itself when it ends.

**Confirmed on TrueNAS SCALE, 22 Nov 2026.** An owner ran this method there and got `paperclip-issues.json`. If a step fails on your host, note the error and the step letter, and [tell us on GitHub](@repo/issues).

### a. Make a working folder

Everything below reads and writes files in the current folder.

```sh Run on the machine that runs Paperclip
mkdir paperclip-export && cd paperclip-export
```

### b. Find the Paperclip container

```sh Run on the machine that runs Paperclip
docker ps --filter name=paperclip --format '{{.Names}}  {{.Image}}'
```

This lists running containers with `paperclip` in their name, with their images. If it prints nothing, list every running container and find Paperclip's by its image:

```sh Run on the machine that runs Paperclip
docker ps --format '{{.Names}}  {{.Image}}'
```

Pick the Paperclip **app** container, the one running the Paperclip image, not a database container. If your install has a separate database container, such as `paperclip-db` running a `postgres` image, Paperclip uses that database and not the built-in one. Follow [Paperclip uses an external database](#paperclip-uses-an-external-database) below.

Put the app container's name into `CONTAINER`, typing it yourself, and check it. Replace `paperclip-server-1` with the name from the list:

```sh Run on the machine that runs Paperclip, with your container name
CONTAINER=paperclip-server-1
echo "$CONTAINER"
```

:::worked
`echo` prints the container's name. Don't go on until it does: with an empty name, step d fails.
:::

### c. Create paperclip-issues.sql

Copy the whole block, from `cat` to the final `SQL` line, and paste it into the shell.

**Change the issue prefix first.** The one value to change is `HOL` on the line under `CHANGE 'HOL'`. Replace it with your company's issue prefix and keep the quotes. For example, for issues called `ACME-12`, the line reads `WHERE co.issue_prefix = 'ACME' AND i.identifier IS NOT NULL`.

```sh Paste into the shell, with your issue prefix in place of HOL
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

:::worked
`ls paperclip-issues.sql` lists the file.
:::

If you pasted it with the wrong prefix, open `paperclip-issues.sql` in a text editor, change the prefix on that line, and save. Or paste the block again with the right prefix: it replaces the file.

### d. Run the query

This runs `psql` from a throwaway Postgres container:

- `--network container:"$CONTAINER"` puts it on the Paperclip container's network, so `127.0.0.1:54329` reaches Paperclip's database
- `default_transaction_read_only=on` makes the session refuse any write
- `--rm` deletes the container when the query ends

Don't add `-t` to `docker run`: it would mix terminal codes into the JSON.

```sh Run in the working folder
docker run --rm -i --network container:"$CONTAINER" \
  -v "$PWD":/work -w /work \
  -e PGPASSWORD=paperclip -e PGOPTIONS='-c default_transaction_read_only=on' \
  postgres:17-alpine \
  psql -At -v ON_ERROR_STOP=1 "postgres://paperclip@127.0.0.1:54329/paperclip" \
  -f paperclip-issues.sql > paperclip-issues.json
```

### e. Check the result

```sh Run in the working folder
ls -lh paperclip-issues.json && head -c 300 paperclip-issues.json
```

:::worked
The file starts with `[{"identifier":"HOL-`, with your prefix in place of `HOL`.
:::

If something is wrong:

- **The file shows only `[]`.** The prefix in `paperclip-issues.sql` is wrong. Fix it (step c) and run step d again.
- **The file is empty.** Read the error `docker run` printed. `connection refused` usually means the container name in step b is wrong, or Paperclip uses an external database (below).

### Paperclip's image has psql

Check with this command. If it prints a path, you can run the query inside the Paperclip container instead of step d:

```sh Run in the working folder
docker exec "$CONTAINER" which psql
```

Then copy `paperclip-issues.sql` into the container and run the query there:

```sh Run in the working folder, only if the check above printed a path
docker cp paperclip-issues.sql "$CONTAINER":/tmp/paperclip-issues.sql
docker exec -i -w /tmp -e PGPASSWORD=paperclip -e PGOPTIONS='-c default_transaction_read_only=on' "$CONTAINER" \
  psql -At -v ON_ERROR_STOP=1 "postgres://paperclip@127.0.0.1:54329/paperclip" \
  -f paperclip-issues.sql > paperclip-issues.json
```

Then check the result as in step e.

### Paperclip uses an external database

This is a separate database container, such as `paperclip-db`, or its own Postgres server, not the built-in one on `127.0.0.1:54329`.

Point `psql` at that database instead. In step d, replace the `postgres://…` address and `PGPASSWORD` with that database's own host, port, user, password and database name, for example `postgres://paperclip@192.168.1.20:5432/paperclip`. If the database is reachable from the host, you can drop `--network container:"$CONTAINER"`.

## 3. Copy paperclip-issues.json to the computer that holds the export folder

Skip this if it is the same machine as the Docker host.

This step is **not yet confirmed**: it has not yet been run on an owner's machine.

You copy the file with `scp`, run from the computer that holds the export folder (on Windows 10 and later, `scp` works in PowerShell). The Docker host needs SSH turned on. SSH usually refuses a `root` login, so log in as an ordinary user, and first put the file in that user's home folder, owned by them.

On the Docker host, in the working folder, run this. Replace `alex` with that user's login. Leave out `sudo` if you are already root.

```sh Run on the machine that runs Paperclip, with your login in place of alex
sudo cp paperclip-issues.json ~alex/
sudo chown alex: ~alex/paperclip-issues.json
```

Then, on the computer that holds the export folder, go into that folder (the one with `COMPANY.md`) and run this. Replace `alex` with the login and `192.168.1.20` with the Docker host's address:

```sh Run in the export folder, on the computer that holds it
scp alex@192.168.1.20:paperclip-issues.json .
```

It asks for that user's password, unless you use an SSH key.

:::worked
`ls paperclip-issues.json` in the export folder lists the file.
:::

If something is wrong:

- **`scp` says `Connection refused`.** SSH is off on the Docker host.
- **`scp` says `Permission denied`.** Check the login and password, and that the file is in that user's home folder.

**Worked example: TrueNAS SCALE.** Turn SSH on in System → Services → SSH. Log in as the admin user `truenas_admin`, not `root`: in the commands above, replace `alex` with `truenas_admin`.

## 4. Add the file and zip the folder

Make sure `paperclip-issues.json` is next to `COMPANY.md` in the company export folder from step 1. Then zip that folder.

This is the step that gets your issues, comments and wiki pages into the zip. If `paperclip-issues.json` is not beside `COMPANY.md`, the import has no tickets and no wiki.

:::worked
The company export folder lists `COMPANY.md`, `.paperclip.yaml`, `agents/`, `projects/`, `skills/` and `paperclip-issues.json`.
:::

## 5. Import it into Boss Man

1. In Boss Man, open **Settings → Import and export** and pick the zip.
2. Read the preview. Its notes say what was left out or renamed.
3. Choose **Import as a new company**.

:::worked
The preview gives the number of agents, skills, projects, wiki pages and tickets it will bring in. If it says 0 tickets, `paperclip-issues.json` was missing from the zip or was not next to `COMPANY.md`: go back to step 4.
:::

## 6. Work through the checklist

After the import, Boss Man gives you a checklist decision. Work through it in this order:

1. Add each secret and grant it to the agents that need it.
2. Give agents a funding source.
3. Read any skill scripts it lists.
4. Unpause agents one at a time.

:::note Rotate leaked secrets first
Rotate any secret that ever appeared in a Paperclip run log or issue before you add it to Boss Man. The issues export carries comments word for word, so a key pasted into a comment comes across too.
:::

Next: [Your first company and task](/guides/first-company-and-ticket) shows how the board, tickets and Decisions work in Boss Man.
