# The Claude pack

The runner image ships no Anthropic code (DR-050). Claude Code and its ACP adapter are
installed on a runner's first start from this folder's pinned, lockfile-verified packages
into a content-addressed folder on the `bossman-claude` named volume.

- `package.json` pins exact versions. `package-lock.json` records every package's fingerprint
  (integrity hash), so `npm ci` refuses a swapped or tampered package.
- The runner mounts the volume **read-only**. The installer (the same image, another command)
  writes it: `npm ci`, then `claude --version`, then the canary, then a `READY` marker.
- A folder's name is the sha256 of `package-lock.json` (first 24 hex characters), so an update
  installs beside the old one and a rollback is a matter of picking the old folder.

To bump a version, change the exact numbers in `package.json`, then run here:

```sh
npm install --package-lock-only
```

Commit both files. Every runner installs the new folder on its next start; the old one is left
in place.
