#!/usr/bin/env node
// Merge-line scan (BOS-979): blocks a change whose ADDED lines (or new commit messages / author emails) hold a secret or one
// of the owner's real private details. No dependencies, no network.
//
//   node scripts/scan-added-lines.mjs [base-ref]        base-ref defaults to origin/main; scans base...HEAD
//
// Secret rules are built in. The owner's private details (real IPs, host names, paths, personal email) come from a list FILE
// that the server hands to the runner at the merge gate (BOSSMAN_SCAN_DENYLIST_FILE), one "kind<TAB>value" per line, kind one
// of ip, host, path, email, other (a bare line counts as other; an ip may be a CIDR such as 192.0.2.0/24 or a prefix ending
// in a dot). The list is never in the repo. With no list the secret rules still run.
//
// Output never contains a matched value: a secret finding prints its kind, file:line and the value's length. A secret finding
// also prints a short fingerprint (first 12 hex of the value's SHA-256) so a reviewer can put a genuine false positive in
// scripts/scan-allow.txt:
//   <path><TAB><rule><TAB><fingerprint><TAB><reason>
// Listed (denylist) findings print no fingerprint, since a short value such as an IP could be guessed back from one. Nor do
// they print the file, line or kind (BOS-1390): the merge output goes back to the ticket's agent, so naming where a listed
// value sits would let an agent test one guess per merge attempt after approval. The owner can see the location elsewhere.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SKIP_PATH = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i
// Values that are obviously made up: never a secret.
const PLACEHOLDER = /(example|changeme|change-me|placeholder|your[-_]|xxxx|<[^>]*>|\$\{|\$[A-Z_]+|\{\{|dummy|fake|redacted|\*{3,}|\.{3})/i

const entropy = (s) => {
  const counts = new Map()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

// kind -> [regex, optional filter on the matched text]. The regex's first capture group (or whole match) is "the value".
export const SECRET_RULES = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d/],
  ['anthropic-key', /\bsk-ant-(?:api|oat|admin)\d*-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)(?:or-v1-|proj-)?[A-Za-z0-9_-]{32,}/, (v) => entropy(v) > 3.5],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['tailscale-key', /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/],
  // BOS-1932: providers Boss Man companies use that GitHub's secret scanning knows and this list did not.
  ['gitlab-token', /\bgl(?:pat|dt|rt|ptt|cbt|soat|ffct|agent|imt|oas)-[A-Za-z0-9_-]{20,}/],
  ['docker-hub-token', /\bdckr_(?:pat|oat)_[A-Za-z0-9_-]{24,}/],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{34,}\b/],
  ['ntfy-token', /\btk_[a-z0-9]{29}\b/],
  ['google-oauth-secret', /\bGOCSPX-[A-Za-z0-9_-]{28}\b/],
  ['atlassian-token', /\b(?:ATBB[A-Za-z0-9_=.-]{28,}|ATATT3[A-Za-z0-9_=-]{100,}|ATCTT3[A-Za-z0-9_=-]{100,})/],
  ['slack-webhook', /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/T[A-Z0-9]{6,}\/[A-Za-z0-9/]{20,}/],
  ['cloudflare-tunnel-token', /\beyJhIjoi[A-Za-z0-9+/_-]{80,}={0,2}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, (v) => !/EXAMPLE/.test(v)],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-key', /\b[sr]k_live_[0-9a-zA-Z]{20,}/],
  ['bossman-token', /\b(?:bm_sess_|bmr_)[A-Za-z0-9_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'url-with-credentials',
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:([^\s@/'"`]{8,})@[^\s'"`]+/i,
    (v) => !PLACEHOLDER.test(v) && !/^(pass(word)?|secret|postgres|root|admin|user|test|token|boss|bossman)$/i.test(v),
  ],
  ['bearer-token', /Authorization['"]?\s*[:=]\s*['"`]?Bearer\s+([A-Za-z0-9._~+/=-]{20,})/i, (v) => !PLACEHOLDER.test(v)],
  ['token-in-url', /[?&](?:access_token|token|api_key|apikey|key)=([A-Za-z0-9._~-]{20,})/i, (v) => !PLACEHOLDER.test(v) && entropy(v) > 3.5],
  [
    'secret-assignment',
    /\b[A-Za-z0-9_]*(?:secret|password|passwd|token|api_?key|master_?key|private_?key)[A-Za-z0-9_]*['"]?\s*[:=]\s*['"`]([A-Za-z0-9+/=_-]{24,})['"`]/i,
    (v) => !PLACEHOLDER.test(v) && entropy(v) > 3.5,
  ],
]

// New files whose NAME is the problem. Block these; archives and dumps only warn (scanners don't open them).
const BAD_NAME = /(^|\/)(\.env(\.[^/]*)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*)$/
const OK_NAME = /(^|\/)\.env\.(example|sample|template)$|(^|\/)(public|[^/]*\.pub)\.key$/
const WARN_NAME = /\.(tgz|tar\.gz|zip|sql|sql\.gz|dump)$/

const fp = (v) => createHash('sha256').update(v).digest('hex').slice(0, 12)

export function parseDenylist(text) {
  const out = []
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const tab = line.indexOf('\t')
    let kind = 'other', value = line
    if (tab > 0) { kind = line.slice(0, tab).trim().toLowerCase(); value = line.slice(tab + 1) }
    value = value.trim()
    if (value.length < 3) continue // a one- or two-character entry would match everything
    if (!['ip', 'host', 'path', 'email', 'other'].includes(kind)) { kind = 'other' }
    out.push({ kind, value })
  }
  return out
}

const ipToInt = (s) => {
  const p = s.split('.').map(Number)
  return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null
}

// Does this line contain a listed value? Returns the kind or null. Case-insensitive; an ip entry matches whole addresses only
// (192.0.2.5 does not match 192.0.2.50), a trailing-dot entry is a prefix, a /nn entry is a CIDR range.
export function matchDenylist(line, list) {
  const lower = line.toLowerCase()
  for (const { kind, value } of list) {
    const v = value.toLowerCase()
    if (kind === 'ip') {
      const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(v)
      if (cidr) {
        const base = ipToInt(cidr[1]), bits = Number(cidr[2])
        if (base === null || bits > 32) continue
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
        for (const m of line.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d])/g)) {
          const n = ipToInt(m[1])
          if (n !== null && (n & mask) >>> 0 === (base & mask) >>> 0) return kind
        }
        continue
      }
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = v.endsWith('.') ? new RegExp(`(?<![\\d.])${esc}`) : new RegExp(`(?<![\\d.])${esc}(?![\\d])(?!\\.\\d)`)
      if (re.test(lower)) return kind
    } else if (lower.includes(v)) return kind
  }
  return null
}

export function parseAllow(text) {
  const set = new Set()
  for (const raw of (text ?? '').split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) continue
    const [path, rule, hash, reason] = raw.split('\t')
    if (path && rule && hash && reason?.trim()) set.add(`${path}\t${rule}\t${hash}`)
  }
  return set
}

// diff: output of `git diff -U0 --no-color`. Returns [{file, line, text}] of added lines.
export function addedLines(diff) {
  const out = []
  let file = null, ln = 0, inHeader = false
  // File headers (---/+++) only exist between a "diff --git" line and the first "@@": inside a hunk every line starting
  // with "+" is an ADDED line, even one whose text begins "++ " (git shows it as "+++ ..."). Reading it as a header would
  // let a branch hide a token (Freddy's finding on BOS-979).
  // A merge commit's own content (its conflict resolution) comes as a combined diff ("diff --cc", "@@@ -a -b +c @@@"):
  // each line has one prefix column per parent, and a line with a "+" and no "-" in them is in the result (BOS-1043).
  let parents = 1
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ') || l.startsWith('diff --cc ') || l.startsWith('diff --combined ')) { inHeader = true; file = null; parents = 1; continue }
    const c = /^@@@+ (?:-\S+ )+\+(\d+)(?:,\d+)? @@@+/.exec(l)
    if (c) { inHeader = false; ln = Number(c[1]); parents = l.indexOf(' ') - 1; continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { inHeader = false; ln = Number(h[1]); parents = 1; continue }
    if (inHeader) {
      if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6)
      continue
    }
    if (!file) continue
    if (parents === 1) {
      if (l.startsWith('+')) { out.push({ file, line: ln, text: l.slice(1) }); ln++ }
    } else {
      const pre = l.slice(0, parents)
      if (pre.includes('-')) continue
      if (pre.includes('+')) { out.push({ file, line: ln, text: l.slice(parents) }); ln++ } else if (pre.trim() === '' && l.length >= parents) ln++
    }
  }
  return out
}

// items: [{file, line, text}]; extra: [{where, text}] (commit messages, author emails). Returns {blocked, warnings}.
export function scan({ items, extra = [], newFiles = [], denylist = [], allow = new Set() }) {
  const blocked = [], warnings = []
  for (const f of newFiles) {
    if (OK_NAME.test(f)) continue
    if (BAD_NAME.test(f)) blocked.push({ kind: 'secret-file-name', where: f, note: 'a key, certificate or .env file must not be committed' })
    else if (WARN_NAME.test(f)) warnings.push({ kind: 'archive-or-dump', where: f, note: 'archives and database dumps are not opened by the scan: check them by hand' })
  }
  const check = (where, file, text) => {
    for (const [kind, re, ok] of SECRET_RULES) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
      for (const m of text.matchAll(g)) {
        const v = m[1] ?? m[0]
        if (ok && !ok(v)) continue
        if (file && allow.has(`${file}\t${kind}\t${fp(v)}`)) continue
        blocked.push({ kind, where, length: v.length, fingerprint: fp(v) })
      }
    }
    const k = matchDenylist(text, denylist)
    if (k) blocked.push({ kind: `listed-private-${k}`, where, listed: true })
  }
  // Nothing is skipped by its name (Freddy, round 2; Jane, BOS-1043): a lockfile's added lines go through the secret rules
  // like any file (its integrity hashes match none of them), and a line of an image/font/pdf-named file has its NUL and
  // undecodable bytes stripped and what is left scanned, so a key beside a NUL byte in x.png is still found.
  for (const it of items) {
    // NUL is stripped from every file (a UTF-16 file reads as text with NULs between the letters).
    const text = it.text.replace(SKIP_PATH.test(it.file) ? /[\0�]/g : /\0/g, '')
    check(`${it.file}:${it.line}`, it.file, text)
  }
  for (const e of extra) check(e.where, null, e.text)
  return { blocked, warnings }
}

export function format({ blocked, warnings }) {
  const lines = []
  for (const b of blocked) {
    if (b.listed) lines.push(`BLOCKED a listed private detail was found in this change. Replace every real value with a made-up example such as 192.168.1.50, example.com or myserver. (The file, line and kind are not shown, so this output can't be used to work out which value matched.)`)
    else if (b.fingerprint) lines.push(`BLOCKED ${b.kind} at ${b.where}: looks like a real secret, ${b.length} characters (value not shown). Remove it and use an environment variable or the Secrets store. A genuine false positive goes in scripts/scan-allow.txt (needs review) with fingerprint ${b.fingerprint}.`)
    else lines.push(`BLOCKED ${b.kind} at ${b.where}: ${b.note} (not shown).`)
  }
  for (const w of warnings) lines.push(`WARNING ${w.kind} at ${w.where}: ${w.note}`)
  return lines.join('\n')
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

// ---- Whole-tree pass (BOS-1932) ----------------------------------------------------------------------------------------
// The merge-line scan above only reads what a branch ADDS, so anything on main from before it started (9 Nov) was never
// read. `--tree <ref>` runs the same SECRET_RULES (and the file-name rule) over every file of <ref>, read straight from git's
// objects, so it works in a bare repo and checks out nothing. scripts/scan-allow.txt is NOT applied here: a key-shaped test
// fixture must be built at run time instead, so no list can hide a real key on main. Nor is the owner's private-details list:
// this pass reports file and line, which a listed hit must never do (BOS-1390).
//
//   node scripts/scan-added-lines.mjs --tree <ref> [--json]
//
// --json prints one object: { commit, files, skipped: [{file, bytes}], findings: [{kind, file, line, commit, fingerprint, length}] }
// (`commit` on a finding is the commit that last changed that line, from git blame; null when git can't say). Never a value.
// Without --json it prints the BLOCKED lines and exits 1 when there is a finding.

/** Files larger than this are not read (listed in `skipped`, so a reader knows they weren't). */
export const TREE_FILE_MAX = 20 * 1024 * 1024

/** `git ls-tree -r -z -l` output -> [{path, sha, size}] of the blobs (submodules are commits and are left out). */
export function parseLsTree(out) {
  const files = []
  for (const rec of out.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha, size] = rec.slice(0, tab).trim().split(/\s+/)
    if (type !== 'blob' || !sha) continue
    files.push({ path: rec.slice(tab + 1), sha, size: Number(size) || 0, mode })
  }
  return files
}

/** `git cat-file --batch` output -> Map(sha -> Buffer). */
export function parseCatFile(buf) {
  const out = new Map()
  let at = 0
  while (at < buf.length) {
    const nl = buf.indexOf(10, at)
    if (nl < 0) break
    const [sha, type, size] = buf.subarray(at, nl).toString('utf8').split(' ')
    if (type === 'missing' || !size) { at = nl + 1; continue }
    const n = Number(size)
    out.set(sha, buf.subarray(nl + 1, nl + 1 + n))
    at = nl + 1 + n + 1
  }
  return out
}

/** Every line of every file as scan() items. A file's NULs (and, for binary-named files, undecodable bytes) are stripped there. */
export function treeItems(files, contents) {
  const items = []
  for (const f of files) {
    const buf = contents.get(f.sha)
    if (!buf) continue
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) if (lines[i]) items.push({ file: f.path, line: i + 1, text: lines[i].replace(/\r$/, '') })
  }
  return items
}

/** Splits scan()'s "file:line" back into its parts (a path may hold ':', the line is after the last one). */
const splitWhere = (where) => {
  const i = where.lastIndexOf(':')
  const line = i > 0 ? Number(where.slice(i + 1)) : NaN
  return Number.isInteger(line) && line > 0 ? { file: where.slice(0, i), line } : { file: where, line: null }
}

/**
 * The whole-tree pass. `run(args, input?)` runs git (returns a Buffer); injected so tests can use a throwaway repo.
 * Returns { commit, files, skipped, findings } as described above.
 */
export function scanTree(ref, run) {
  const commit = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString('utf8').trim()
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`not a commit: ${ref}`)
  const all = parseLsTree(run(['ls-tree', '-r', '-z', '-l', '--full-tree', commit]).toString('utf8'))
  const skipped = all.filter((f) => f.size > TREE_FILE_MAX).map((f) => ({ file: f.path, bytes: f.size }))
  const files = all.filter((f) => f.size <= TREE_FILE_MAX)
  const shas = [...new Set(files.map((f) => f.sha))]
  const contents = shas.length ? parseCatFile(run(['cat-file', '--batch'], shas.join('\n') + '\n')) : new Map()
  const res = scan({ items: treeItems(files, contents), newFiles: files.map((f) => f.path) })
  const blameCache = new Map()
  const lastCommit = (file, line) => {
    const key = `${file}\0${line}`
    if (blameCache.has(key)) return blameCache.get(key)
    let sha = null
    try {
      const out = line
        ? run(['blame', '--porcelain', '-L', `${line},${line}`, commit, '--', file]).toString('utf8')
        : run(['log', '-1', '--format=%H', commit, '--', file]).toString('utf8')
      const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\b/.exec(out.trim())
      sha = m ? m[1] : null
    } catch {
      sha = null
    }
    blameCache.set(key, sha)
    return sha
  }
  const findings = res.blocked.map((b) => {
    const { file, line } = splitWhere(b.where)
    return { kind: b.kind, file, line, commit: lastCommit(file, line), fingerprint: b.fingerprint ?? null, length: b.length ?? null }
  })
  return { commit, files: files.length, skipped, findings }
}

function mainTree(ref, json) {
  const run = (args, input) => execFileSync('git', args, { input, maxBuffer: 1024 * 1024 * 1024 })
  const r = scanTree(ref, run)
  if (json) {
    console.log(JSON.stringify(r))
    return
  }
  for (const f of r.findings) console.log(`FOUND ${f.kind} at ${f.file}${f.line ? `:${f.line}` : ''}${f.length ? `: ${f.length} characters` : ''} (value not shown${f.fingerprint ? `, fingerprint ${f.fingerprint}` : ''}${f.commit ? `, last changed in ${f.commit.slice(0, 12)}` : ''})`)
  for (const s of r.skipped) console.log(`SKIPPED ${s.file}: ${s.bytes} bytes is more than the ${TREE_FILE_MAX} the pass reads`)
  console.log(`scan --tree: ${r.findings.length} finding(s) in ${r.files} files at ${r.commit.slice(0, 12)}`)
  if (r.findings.length) process.exit(1)
}

function main() {
  const t = process.argv.indexOf('--tree')
  if (t >= 0) return mainTree(process.argv[t + 1] ?? 'HEAD', process.argv.includes('--json'))
  const base = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'origin/main'
  const range = `${base}...HEAD`
  // --text: the branch's own .gitattributes ("* -diff") must not turn files into "Binary files differ" and hide lines.
  // T: a type change (symlink to file) is scanned too.
  const flags = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--diff-filter=ACMRT']
  const diff = git(['diff', ...flags, range])
  // Every commit of the branch lands in main's history, so a secret added in one commit and deleted in the next is
  // scanned too (Freddy, round 2). Bounded: past MAX_COMMITS the check fails rather than skipping.
  const MAX_COMMITS = 300
  const nCommits = Number(git(['rev-list', '--count', `${base}..HEAD`]).trim())
  if (nCommits > MAX_COMMITS) {
    console.log(`BLOCKED too-many-commits at ${base}..HEAD: ${nCommits} commits is more than the ${MAX_COMMITS} the scan reads one by one. Squash the branch.`)
    process.exit(1)
  }
  // --cc: a merge commit shows only its own resolution (what differs from every parent), so merging main in adds nothing.
  const perCommit = git(['log', '-p', '--cc', '--format=', ...flags, `${base}..HEAD`])
  const newFiles = git(['diff', '--name-only', '--diff-filter=AR', range]).split('\n').filter(Boolean)
  const extra = []
  const log = git(['log', '--format=%x00%h%x01%ae%x01%ce%x01%B', `${base}..HEAD`])
  for (const rec of log.split('\0').filter(Boolean)) {
    const [h, ae, ce, ...body] = rec.split('\x01')
    extra.push({ where: `commit ${h} message`, text: body.join('\x01') }, { where: `commit ${h} author email`, text: `${ae} ${ce}` })
  }
  // The runner passes the list on stdin (--list-stdin): no file for another process to read. The file variable stays for
  // a hand run of the scanner.
  const listFile = process.env.BOSSMAN_SCAN_DENYLIST_FILE
  const denylist = process.argv.includes('--list-stdin')
    ? parseDenylist(readFileSync(0, 'utf8'))
    : listFile && existsSync(listFile) ? parseDenylist(readFileSync(listFile, 'utf8')) : []
  const allowPath = fileURLToPath(new URL('./scan-allow.txt', import.meta.url))
  const allow = existsSync(allowPath) ? parseAllow(readFileSync(allowPath, 'utf8')) : new Set()
  // The commit messages are multi-line: scan line by line so a finding names its commit, not a position in a blob.
  const seen = new Set()
  const items = [...addedLines(diff), ...addedLines(perCommit)].filter((i) => {
    const key = `${i.file}\t${i.line}\t${i.text}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
  if (!denylist.length) console.log("scan: NOTE the owner's private-details list was not applied (empty or not readable); only the secret rules ran")
  const res = scan({ items, extra: extra.flatMap((e) => e.text.split('\n').map((t) => ({ where: e.where, text: t }))), newFiles, denylist, allow })
  const out = format(res)
  if (out) console.log(out)
  if (res.blocked.length) {
    console.log(`scan: ${res.blocked.length} finding(s); the owner's list has ${denylist.length} entr${denylist.length === 1 ? 'y' : 'ies'}`)
    process.exit(1)
  }
  console.log(`scan: no secrets or listed private details in the added lines (${denylist.length} listed entr${denylist.length === 1 ? 'y' : 'ies'} checked)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
