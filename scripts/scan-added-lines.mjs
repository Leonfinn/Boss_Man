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
// Output never contains a matched value: only kind, file:line and the value's length. A secret finding also prints a short
// fingerprint (first 12 hex of the value's SHA-256) so a reviewer can put a genuine false positive in scripts/scan-allow.txt:
//   <path><TAB><rule><TAB><fingerprint><TAB><reason>
// Listed (denylist) findings print no fingerprint, since a short value such as an IP could be guessed back from one.
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
  let file = null, ln = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); continue }
    if (l.startsWith('--- ') || l.startsWith('diff --git') || l.startsWith('index ')) continue
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { ln = Number(h[1]); continue }
    if (file && l.startsWith('+')) { out.push({ file, line: ln, text: l.slice(1) }); ln++ }
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
  for (const it of items) if (!SKIP_PATH.test(it.file)) check(`${it.file}:${it.line}`, it.file, it.text)
  for (const e of extra) check(e.where, null, e.text)
  return { blocked, warnings }
}

export function format({ blocked, warnings }) {
  const lines = []
  for (const b of blocked) {
    if (b.listed) lines.push(`BLOCKED ${b.kind} at ${b.where}: the line holds a private detail from the owner's list (value not shown). Replace it with a made-up example such as 192.168.1.50, example.com or myserver.`)
    else if (b.fingerprint) lines.push(`BLOCKED ${b.kind} at ${b.where}: looks like a real secret, ${b.length} characters (value not shown). Remove it and use an environment variable or the Secrets store. A genuine false positive goes in scripts/scan-allow.txt (needs review) with fingerprint ${b.fingerprint}.`)
    else lines.push(`BLOCKED ${b.kind} at ${b.where}: ${b.note} (not shown).`)
  }
  for (const w of warnings) lines.push(`WARNING ${w.kind} at ${w.where}: ${w.note}`)
  return lines.join('\n')
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

function main() {
  const base = process.argv[2] ?? 'origin/main'
  const range = `${base}...HEAD`
  const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR', range])
  const newFiles = git(['diff', '--name-only', '--diff-filter=AR', range]).split('\n').filter(Boolean)
  const extra = []
  const log = git(['log', '--no-merges', '--format=%x00%h%x01%ae%x01%ce%x01%B', `${base}..HEAD`])
  for (const rec of log.split('\0').filter(Boolean)) {
    const [h, ae, ce, ...body] = rec.split('\x01')
    extra.push({ where: `commit ${h} message`, text: body.join('\x01') }, { where: `commit ${h} author email`, text: `${ae} ${ce}` })
  }
  const listFile = process.env.BOSSMAN_SCAN_DENYLIST_FILE
  const denylist = listFile && existsSync(listFile) ? parseDenylist(readFileSync(listFile, 'utf8')) : []
  const allowPath = fileURLToPath(new URL('./scan-allow.txt', import.meta.url))
  const allow = existsSync(allowPath) ? parseAllow(readFileSync(allowPath, 'utf8')) : new Set()
  // The commit messages are multi-line: scan line by line so a finding names its commit, not a position in a blob.
  const res = scan({ items: addedLines(diff), extra: extra.flatMap((e) => e.text.split('\n').map((t) => ({ where: e.where, text: t }))), newFiles, denylist, allow })
  const out = format(res)
  if (out) console.log(out)
  if (res.blocked.length) {
    console.log(`scan: ${res.blocked.length} finding(s); the owner's list has ${denylist.length} entr${denylist.length === 1 ? 'y' : 'ies'}`)
    process.exit(1)
  }
  console.log(`scan: no secrets or listed private details in the added lines (${denylist.length} listed entr${denylist.length === 1 ? 'y' : 'ies'} checked)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
