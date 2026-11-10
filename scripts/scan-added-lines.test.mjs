import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { addedLines, scan, format, parseDenylist, parseAllow } from './scan-added-lines.mjs'

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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
