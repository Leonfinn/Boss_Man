// BOS-1860: which failed merge steps are only the network to the git host (retried once by itself) and which are the
// host refusing them (never retried). Texts are git's own stderr, as the runner passes it on in its error.
import { describe, expect, it } from "vitest";
import { isGitTransportFault } from "../src/services/git-transport-fault.js";

const URL = "https://github.com/example/repo.git/";

/** Network or HTTP failures: retried. */
const TRANSPORT: Array<[string, string]> = [
  ["today's BOS-1844 text", `Couldn't push the merge commit to bossman-ci/fc5ce221 for the git host's CI: fatal: unable to access '${URL}': Could not resolve host: github.com`],
  ["failed to connect", `fatal: unable to access '${URL}': Failed to connect to github.com port 443 after 129 ms: Couldn't connect to server`],
  ["connection timed out", `fatal: unable to access '${URL}': Connection timed out after 300000 milliseconds`],
  ["operation timed out", `fatal: unable to access '${URL}': Operation timed out after 300000 milliseconds with 0 out of 0 bytes received`],
  ["GnuTLS recv error", `fatal: unable to access '${URL}': GnuTLS recv error (-110): The TLS connection was non-properly terminated.`],
  ["gnutls handshake", `fatal: unable to access '${URL}': gnutls_handshake() failed: Error in the pull function.`],
  ["OpenSSL SSL_read", "error: RPC failed; curl 56 OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 104"],
  ["HTTP/2 stream", "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)"],
  ["empty reply", `fatal: unable to access '${URL}': Empty reply from server`],
  ["RPC failed HTTP 500", "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500"],
  ["502 on fetch", "Command failed: git fetch --quiet origin\nerror: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"],
  ["503", `fatal: unable to access '${URL}': The requested URL returned error: 503`],
  ["408", `fatal: unable to access '${URL}': The requested URL returned error: 408`],
  ["429 rate limit", `fatal: unable to access '${URL}': The requested URL returned error: 429`],
  ["remote hung up", "send-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly"],
  ["early EOF", "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output"],
  ["connection reset", "error: RPC failed; curl 56 Recv failure: Connection reset by peer"],
  ["connection refused (ssh)", "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository."],
  ["ssh resolve", "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository."],
  ["kex", "kex_exchange_identification: read: Connection reset by peer\nfatal: Could not read from remote repository."],
  ["network unreachable", `fatal: unable to access '${URL}': Failed to connect to github.com port 443: Network is unreachable`],
];

/** The git host (or Boss Man) refusing the step: never retried. */
const REFUSED: Array<[string, string]> = [
  ["non-fast-forward", `Couldn't push the merge to main: To ${URL}\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to '${URL}'`],
  ["fetch first", ` ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '${URL}'`],
  ["stale info", ` ! [rejected]        main -> main (stale info)\nerror: failed to push some refs`],
  ["protected branch", `remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)`],
  ["pre-receive hook", ` ! [remote rejected] main -> main (pre-receive hook declined)`],
  ["workflow scope", ` ! [remote rejected] bossman-ci/x -> bossman-ci/x (refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/ci.yml\` without \`workflow\` scope)`],
  ["auth failed", `remote: Invalid username or password.\nfatal: Authentication failed for '${URL}'`],
  ["403", `remote: Permission to example/repo.git denied to bot.\nfatal: unable to access '${URL}': The requested URL returned error: 403`],
  ["401", `fatal: unable to access '${URL}': The requested URL returned error: 401`],
  ["404 / not found", `remote: Repository not found.\nfatal: repository '${URL}' not found`],
  ["ssh publickey", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."],
  ["no credentials", `fatal: could not read Username for 'https://github.com': No such device or address`],
  ["secrets scan", "Not pushed to GitHub: the secrets scan found something in the branch.\nsrc/a.ts:1 token"],
  ["wrong prepared commit", "The commit to publish (abcdef012345) isn't the one this ticket's merge prepared; prepare it again."],
];

/** Neither: unknown text is not retried. */
const OTHER: Array<[string, string]> = [
  ["a database error", "duplicate key value violates unique constraint \"tickets_pkey\""],
  ["a merge conflict", "CONFLICT (content): Merge conflict in src/a.ts"],
  ["empty", ""],
];

describe("isGitTransportFault (BOS-1860)", () => {
  it.each(TRANSPORT)("retries: %s", (_name, text) => expect(isGitTransportFault(text)).toBe(true));
  it.each(REFUSED)("never retries a refusal: %s", (_name, text) => expect(isGitTransportFault(text)).toBe(false));
  it.each(OTHER)("never retries unknown text: %s", (_name, text) => expect(isGitTransportFault(text)).toBe(false));
  it("a refusal wins over a network phrase in the same message (unable to access ... 403)", () => {
    expect(isGitTransportFault(`fatal: unable to access '${URL}': The requested URL returned error: 403`)).toBe(false);
  });
  it("null and undefined are not faults", () => {
    expect(isGitTransportFault(null)).toBe(false);
    expect(isGitTransportFault(undefined)).toBe(false);
  });
});
