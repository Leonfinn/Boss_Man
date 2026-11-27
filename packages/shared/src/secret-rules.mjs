// The one list of secret shapes (BOS-979, BOS-2731). Plain JavaScript with no imports on purpose: the merge-line scan
// (scripts/scan-added-lines.mjs) runs as a stand-alone script on the runner, and the server imports the same file to refuse
// a token written into a wiki page, ticket, reply or card. Never copy these expressions; import them.

// Values that are obviously made up: never a secret.
export const PLACEHOLDER = /(example|changeme|change-me|placeholder|your[-_]|xxxx|<[^>]*>|\$\{|\$[A-Z_]+|\{\{|dummy|fake|redacted|\*{3,}|\.{3})/i

export const entropy = (s) => {
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
    /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@'"`]+:([^\s@/'"`]{8,})@[^\s'"`]+/i,
    (v) => !PLACEHOLDER.test(v) && !/^(pass(word)?|secret|postgres|root|admin|user|test|token|boss|bossman)$/i.test(v),
  ],
  ['bearer-token', /Authorization['"]?\s*[:=]\s*['"`]?Bearer\s+([A-Za-z0-9._~+/=-]{20,})/i, (v) => !PLACEHOLDER.test(v)],
  ['token-in-url', /[?&](?:access_token|token|api_key|apikey|key)=([A-Za-z0-9._~-]{20,})/i, (v) => !PLACEHOLDER.test(v) && entropy(v) > 3.5],
  [
    'secret-assignment',
    // Both name parts are capped (BOS-2731): unbounded, one long run of word characters took quadratic time.
    /\b[A-Za-z0-9_]{0,64}(?:secret|password|passwd|token|api_?key|master_?key|private_?key)[A-Za-z0-9_]{0,64}['"]?\s*[:=]\s*['"`]([A-Za-z0-9+/=_-]{24,})['"`]/i,
    (v) => !PLACEHOLDER.test(v) && entropy(v) > 3.5,
  ],
]

// The first matching rule's kind for a piece of text, or null. Used where the value must never be shown: the answer is the
// kind and nothing else (no value, position, length or fingerprint).
export function findSecretKind(text) {
  for (const [kind, re, ok] of SECRET_RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of text.matchAll(g)) {
      const v = m[1] ?? m[0]
      if (ok && !ok(v)) continue
      return kind
    }
  }
  return null
}
