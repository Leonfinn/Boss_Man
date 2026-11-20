import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { addedLines, scan, format, parseDenylist, parseAllow, parseCatFile, parseLsTree } from './scan-added-lines.mjs'

// Fake values are built at run time so this file holds no secret-looking literal of its own.
const fakeAnthropic = ['sk', 'ant', 'api03'].join('-') + '-' + 'Zq8vK2mXp4Lr7TnB9wYc3HdF6sJg1UaE5oIi'
const fakeGithub = 'gh' + 'p_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5'
const listedIp = ['192', '0', '2', '77'].join('.') // documentation range, stands in for the owner's real address

const diffOf = (file, ...lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`
const run = (lines, opts = {}) => scan({ items: addedLines(diffOf('src/a.ts', ...lines)), ...opts })

test('a planted fake key is blocked, named by kind, file and line, and never echoed', () => {
  const r = run(['const a = 1', `const k = "${fakeAnthropic}"`])
  assert.equal(r.blocked.length, 1)
  assert.equal(r.blocked[0].kind, 'anthropic-key')
  const out = format(r)
  assert.match(out, /BLOCKED anthropic-key at src\/a\.ts:2/)
  assert.ok(!out.includes(fakeAnthropic.slice(10, 30)))
})

test('github token, private key block, credentialed URL and assignment are blocked', () => {
  const pk = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
  const url = 'postgres://app:' + 'Tr0ub4dor9xQ' + '@db.internal:5432/x'
  const asg = 'API_TOKEN = "' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9b' + '"'
  const kinds = run([fakeGithub, pk, url, asg]).blocked.map((b) => b.kind)
  assert.deepEqual(kinds, ['github-token', 'private-key', 'url-with-credentials', 'secret-assignment'])
})

test('made-up examples pass', () => {
  const r = run([
    'host: 192.168.1.50',
    'url: https://example.com/path?token=${TOKEN}',
    'ssh admin@myserver',
    'DATABASE_URL=postgres://boss:password@localhost:5432/boss',
    'Authorization: Bearer ${token}',
    'Copyright (c) 2026 Some Owner, https://github.com/some-owner/repo',
    'const secret = process.env.SECRET_KEY',
  ])
  assert.deepEqual(r.blocked, [])
})

test('a listed IP is blocked, an unlisted one and a longer neighbour are not', () => {
  const denylist = parseDenylist(`ip\t${listedIp}\n`)
  assert.equal(run([`ssh root@${listedIp}`], { denylist }).blocked[0].kind, 'listed-private-ip')
  assert.deepEqual(run([`ssh root@${listedIp}0`], { denylist }).blocked, [])
  assert.deepEqual(run(['ssh root@192.0.2.5'], { denylist }).blocked, [])
  const out = format(run([`ssh root@${listedIp}`], { denylist }))
  assert.ok(!out.includes(listedIp))
})

test('a listed hit names no file, line or kind, so an agent cannot probe the list with it (BOS-1390)', () => {
  const denylist = parseDenylist(`ip\t${listedIp}\nhost\tnas-box\n`)
  const out = format(run([`ssh root@${listedIp}`, 'ping nas-box'], { denylist }))
  assert.match(out, /a listed private detail was found in this change/)
  assert.ok(!out.includes(listedIp) && !out.includes('nas-box'))
  assert.ok(!out.includes('listed-private'))
  assert.ok(!out.includes('src/a.ts') && !out.includes(':1') && !out.includes(':2'))
})

test('listed host, path, email (case-insensitive), CIDR and prefix entries', () => {
  const denylist = parseDenylist('host\tnas-box\npath\t/mnt/tank1\nemail\tme@personal.test\nip\t198.51.100.0/24\nip\t203.0.113.\n# comment\n')
  for (const l of ['ping NAS-BOX', 'cd /mnt/tank1/apps', 'mail Me@Personal.test', 'ip 198.51.100.200', 'ip 203.0.113.9']) {
    assert.equal(run([l], { denylist }).blocked.length, 1, l)
  }
  assert.deepEqual(run(['ip 198.51.101.1'], { denylist }).blocked, [])
})

test('an empty list still runs the secret rules', () => {
  assert.equal(run([fakeGithub], { denylist: parseDenylist('') }).blocked.length, 1)
})

test('the allow-list needs a reason and the exact fingerprint', () => {
  const fp = createHash('sha256').update(fakeGithub).digest('hex').slice(0, 12)
  const allow = parseAllow(`src/a.ts\tgithub-token\t${fp}\ttest fixture\n`)
  assert.deepEqual(run([fakeGithub], { allow }).blocked, [])
  assert.equal(run([fakeGithub.replace('aB3', 'xY3')], { allow }).blocked.length, 1)
  assert.equal(run([fakeGithub], { allow: parseAllow(`src/a.ts\tgithub-token\t${fp}\t\n`) }).blocked.length, 1)
})

test('only added lines are scanned and line numbers follow the hunk', () => {
  const diff = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -3 +10,2 @@\n-old ${fakeGithub}\n+fine\n+${fakeGithub}\n`
  const r = scan({ items: addedLines(diff) })
  assert.equal(r.blocked.length, 1)
  assert.match(format(r), /x\.ts:11/)
})

test('key files block, .env.example passes, archives warn', () => {
  const r = scan({ items: [], newFiles: ['.env', 'a/id_rsa', 'cert.pem', '.env.example', 'data.tgz'] })
  assert.equal(r.blocked.length, 3)
  assert.equal(r.warnings.length, 1)
})

test('commit message text is scanned too', () => {
  const r = scan({ items: [], extra: [{ where: 'commit abc1234 message', text: `oops ${fakeGithub}` }] })
  assert.match(format(r), /commit abc1234 message/)
})

// Freddy's finding: an added line whose text starts "++ " shows up in a diff as "+++ ...". It is content, not a file header.
test('an added line that looks like a +++ header is still scanned', () => {
  const r = run([`++ ${fakeGithub}`, 'after'])
  assert.equal(r.blocked.length, 1)
  assert.match(format(r), /src\/a\.ts:1/)
})

test('an added "++ b/x.png" line does not make the scan skip the rest of the hunk', () => {
  const r = run(['++ b/x.png', `token ${fakeGithub}`])
  assert.equal(r.blocked.length, 1)
  assert.match(format(r), /src\/a\.ts:2/)
})

test('a "-- " removed line and a "++ /dev/null" added line do not change the file', () => {
  const diff = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n--- gone\n+++ /dev/null\n+${fakeGithub}\n`
  const r = scan({ items: addedLines(diff) })
  assert.equal(r.blocked.length, 1)
})

// End to end on a real throwaway repo (made-up fake key, built from parts).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scanner = fileURLToPath(new URL('./scan-added-lines.mjs', import.meta.url))
function repoRun(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-e2e-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  try {
    g('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a.txt'), 'hello\n'); g('add', '.'); g('commit', '-qm', 'base')
    g('checkout', '-qb', 'work')
    for (const [i, files] of steps.entries()) {
      for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c)
      g('add', '-A'); g('commit', '-qm', `step ${i}`)
    }
    try { return { code: 0, out: execFileSync('node', [scanner, 'main'], { cwd: dir, encoding: 'utf8' }) } }
    catch (e) { return { code: e.status, out: String(e.stdout) } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('e2e: a key added in one commit and removed in the next is still blocked', () => {
  const r = repoRun([{ 'k.txt': `token = ${fakeGithub}\n` }, { 'k.txt': 'gone\n' }])
  assert.equal(r.code, 1); assert.ok(!r.out.includes(fakeGithub))
})

test('e2e: .gitattributes "* -diff" does not hide an added key', () => {
  const r = repoRun([{ '.gitattributes': '* -diff\n', 'k.txt': `token = ${fakeGithub}\n` }])
  assert.equal(r.code, 1); assert.ok(!r.out.includes(fakeGithub))
})

test('e2e: a text file named yarn.lock or x.png is scanned when new', () => {
  const r = repoRun([{ 'yarn.lock': `token = ${fakeGithub}\n` }])
  assert.equal(r.code, 1)
  const r2 = repoRun([{ 'x.png': `token = ${fakeGithub}\n` }])
  assert.equal(r2.code, 1)
})

test('e2e: a clean branch passes and says the list was not applied', () => {
  const r = repoRun([{ 'b.txt': 'host is myserver.example.com\n' }])
  assert.equal(r.code, 0); assert.match(r.out, /list was not applied/)
})

// BOS-1043 (Jane, round 3): nothing is skipped by its name.
test('e2e: a lockfile added with a key and deleted in the next commit is blocked', () => {
  const r = repoRun([{ 'yarn.lock': `token = ${fakeGithub}\n` }, { 'yarn.lock': 'clean\n' }])
  assert.equal(r.code, 1); assert.ok(!r.out.includes(fakeGithub))
})

test('e2e: a key appended to an existing lockfile is blocked, an integrity hash is not', () => {
  const hash = 'sha512-' + 'q8Zr3kLm0pXw7TnB9vYc2HdF6sJg1UaE5oIiKt4Nb8QyPxCz3VfRgWh0MlSj6DaEu7TyOnBvXk1QpLw=='
  const ok = repoRun([{ 'pnpm-lock.yaml': `a:\n  resolution: {integrity: ${hash}}\n` }])
  assert.equal(ok.code, 0, ok.out)
  const r = repoRun([{ 'pnpm-lock.yaml': 'a: 1\n' }, { 'pnpm-lock.yaml': `a: 1\nb: ${fakeGithub}\n` }])
  assert.equal(r.code, 1)
})

test('e2e: a key beside a NUL byte or U+FFFD in an image-named file is blocked', () => {
  assert.equal(repoRun([{ 'x.png': `\0${fakeGithub}\0\n` }]).code, 1)
  assert.equal(repoRun([{ 'x.woff': `�${fakeGithub}�\n` }]).code, 1)
})

test('e2e: a key a merge commit adds in its own resolution is blocked even if the next commit removes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-merge-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  const scanIt = () => { try { return { code: 0, out: execFileSync('node', [scanner, 'main'], { cwd: dir, encoding: 'utf8' }) } } catch (e) { return { code: e.status, out: String(e.stdout) } } }
  try {
    g('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'base')
    g('checkout', '-qb', 'side'); writeFileSync(join(dir, 'a.txt'), 'side\n'); g('commit', '-qam', 'side')
    g('checkout', '-q', 'main'); g('checkout', '-qb', 'work'); writeFileSync(join(dir, 'a.txt'), 'work\n'); g('commit', '-qam', 'work')
    try { g('merge', '--no-edit', 'side') } catch { /* conflict expected */ }
    writeFileSync(join(dir, 'a.txt'), `resolved ${fakeGithub}\n`); g('add', '.'); g('commit', '-qm', 'merge')
    writeFileSync(join(dir, 'a.txt'), 'clean\n'); g('commit', '-qam', 'tidy')
    // origin/main stands in as "main" here; the merged-in "side" commit is not on main, so only the resolution has the key.
    const r = scanIt()
    assert.equal(r.code, 1, r.out); assert.ok(!r.out.includes(fakeGithub))
    assert.match(r.out, /github-token at a\.txt:1/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('e2e: the list can come on stdin (--list-stdin)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-stdin-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  try {
    g('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a.txt'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base')
    g('checkout', '-qb', 'work'); writeFileSync(join(dir, 'b.txt'), `host ${listedIp}\n`); g('add', '.'); g('commit', '-qm', 'w')
    let code = 0, out = ''
    try { out = execFileSync('node', [scanner, 'main', '--list-stdin'], { cwd: dir, encoding: 'utf8', input: `ip\t${listedIp}\n` }) } catch (e) { code = e.status; out = String(e.stdout) }
    assert.equal(code, 1); assert.match(out, /BLOCKED a listed private detail was found in this change/); assert.ok(!out.includes(listedIp)); assert.ok(!out.includes('b.txt'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- BOS-1932: provider rules GitHub knows, and the whole-tree pass ----

test('provider keys GitHub secret scanning knows are blocked: Tailscale placeholders too', () => {
  const shapes = {
    'tailscale-key': ['tskey', 'auth', 'PASTE-YOUR-KEY'].join('-'),
    'gitlab-token': 'glpat' + '-' + 'aB3dE5gH7jK9mN1pQ3sT',
    'docker-hub-token': 'dckr' + '_pat_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ',
    'huggingface-token': 'hf' + '_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3h',
    'ntfy-token': 'tk' + '_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o',
    'google-oauth-secret': 'GOCSPX' + '-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9b',
    'atlassian-token': 'ATBB' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5',
    'slack-webhook': 'https://hooks.slack' + '.com/services/T0123ABCD/B0123ABCD/aB3dE5gH7jK9mN1pQ3sT5vW7',
    'cloudflare-tunnel-token': 'eyJhIjoi' + 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODkiLCJ0IjoiMDEyMzQ1NjctODlhYi1jZGVmLTAxMjMtNDU2Nzg5YWJjZGVmIiwicyI6Ik1USXpORFUyTnpnNU1BPT0ifQ==',
  }
  for (const [kind, v] of Object.entries(shapes)) {
    const r = run([`x = ${v}`])
    assert.ok(r.blocked.some((b) => b.kind === kind), `${kind} not found: ${JSON.stringify(r.blocked)}`)
    assert.ok(!format(r).includes(v))
  }
  // Prose and short ids stay quiet.
  assert.deepEqual(run(['the ntfy topic tk_short', 'hf_ is the prefix', 'TS_AUTHKEY=PASTE-THE-KEY-FROM-STEP-2']).blocked, [])
})

function treeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-tree-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  g('init', '-q', '-b', 'main')
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text) }
  g('add', '-A'); g('commit', '-qm', 'old')
  return { dir, g }
}
const treeScan = (dir, ...extra) => {
  try { return { code: 0, out: execFileSync('node', [scanner, '--tree', 'main', ...extra], { cwd: dir, encoding: 'utf8' }) } } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) } }
}

test('e2e --tree: finds a key that was on main before any merge-line scan, with file, line and the commit; never the value', () => {
  const { dir, g } = treeRepo({ 'docs/guide.md': 'intro\n\n', 'src/ok.ts': 'export const a = 1\n' })
  try {
    const first = g('rev-parse', 'HEAD').trim()
    // A later commit adds the key: blame must name that one, not the first.
    writeFileSync(join(dir, 'docs/guide.md'), `intro\n\nkey: ${fakeGithub}\n`); g('commit', '-qam', 'add key')
    const added = g('rev-parse', 'HEAD').trim()
    // A .env committed long ago is a finding by its name alone.
    writeFileSync(join(dir, '.env'), 'X=1\n'); g('add', '.env'); g('commit', '-qm', 'env')
    const r = treeScan(dir, '--json')
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.out.includes(fakeGithub))
    const j = JSON.parse(r.out)
    assert.equal(j.commit, g('rev-parse', 'HEAD').trim())
    assert.equal(j.files, 3)
    const key = j.findings.find((f) => f.kind === 'github-token')
    assert.deepEqual({ file: key.file, line: key.line, commit: key.commit, length: key.length }, { file: 'docs/guide.md', line: 3, commit: added, length: fakeGithub.length })
    assert.match(key.fingerprint, /^[0-9a-f]{12}$/)
    assert.notEqual(key.commit, first)
    const env = j.findings.find((f) => f.kind === 'secret-file-name')
    assert.equal(env.file, '.env'); assert.equal(env.line, null); assert.equal(env.fingerprint, null)
    // Human output exits 1 and still holds no value.
    const h = treeScan(dir)
    assert.equal(h.code, 1); assert.match(h.out, /FOUND github-token at docs\/guide\.md:3/); assert.ok(!h.out.includes(fakeGithub))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('e2e --tree: scan-allow.txt does not hide a key on main, and a clean tree reports nothing', () => {
  const { dir } = treeRepo({ 'a.ts': `const k = "${fakeAnthropic}"\n`, 'scripts/scan-allow.txt': `a.ts\tanthropic-key\t${createHash('sha256').update(fakeAnthropic).digest('hex').slice(0, 12)}\treviewed\n` })
  try {
    const j = JSON.parse(treeScan(dir, '--json').out)
    assert.deepEqual(j.findings.map((f) => f.kind), ['anthropic-key'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const clean = treeRepo({ 'a.ts': 'const k = process.env.KEY\n', 'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]) })
  try {
    const j = JSON.parse(treeScan(clean.dir, '--json').out)
    assert.deepEqual(j.findings, []); assert.deepEqual(j.skipped, []); assert.equal(j.files, 2)
  } finally { rmSync(clean.dir, { recursive: true, force: true }) }
})

test('e2e --tree: a key in a binary-named file next to NUL bytes is still found', () => {
  const { dir } = treeRepo({ 'x.png': Buffer.concat([Buffer.from([0x89, 0x50, 0, 0x20]), Buffer.from(fakeGithub), Buffer.from([0, 0xff, 10])]) })
  try {
    const j = JSON.parse(treeScan(dir, '--json').out)
    assert.deepEqual(j.findings.map((f) => [f.kind, f.file, f.line]), [['github-token', 'x.png', 1]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseCatFile reads back-to-back blobs, including one holding newlines and a missing object', () => {
  const a = Buffer.from('one\ntwo\n'), b = Buffer.from('three')
  const buf = Buffer.concat([Buffer.from(`aaa blob ${a.length}\n`), a, Buffer.from('\n'), Buffer.from('zzz missing\n'), Buffer.from(`bbb blob ${b.length}\n`), b, Buffer.from('\n')])
  const m = parseCatFile(buf)
  assert.equal(m.get('aaa').toString(), 'one\ntwo\n'); assert.equal(m.get('bbb').toString(), 'three'); assert.equal(m.has('zzz'), false)
  assert.deepEqual(parseLsTree('100644 blob abc     12\tdir/a b.txt\x00160000 commit def       -\tsub\x00').map((f) => [f.path, f.sha, f.size]), [['dir/a b.txt', 'abc', 12]])
})
