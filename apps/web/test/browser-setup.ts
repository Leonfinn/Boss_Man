// Shared browser start for every web test that drives Chromium (BOS-1784, the class behind BOS-1708 and BOS-1725).
//
// Why: 25 test files each launched their own Chromium inside the test body, so the browser's start was paid out of
// the test's own 60 s budget. On a GitHub runner (4 vCPUs, many test files starting browsers at once, a cold disk
// cache on the first start) the start alone could use most of that budget, and whichever test started its browser
// first (status-tags-feed-render, wrap-up-layout) timed out with a message that said nothing about the browser.
//
// What this does, for a test file that mentions playwright (nothing happens for jsdom-only files):
//  1. Wraps playwright's `chromium.launch` once per process: each attempt has its own launch deadline
//     (LAUNCH_DEADLINE_MS, separate from the test timeout), a failed attempt is retried (a missing executable is not:
//     the tests step to the next candidate), the flags that keep Chromium alive in Docker and on a busy host are
//     always set, and a slow start says so on stderr, so a log shows where the time went.
//  2. Starts and closes one browser in a beforeAll with its own long hook timeout, so the cold start (the slow one)
//     is paid there and not inside a test body. Later starts in the same file reuse the warm binary.
//
// What the limits still catch: a launch that hangs fails after LAUNCH_DEADLINE_MS per attempt with "browser launch",
// not as a bare 60 s test timeout; the tests' own 60 s still catches a page that never draws.
//
// BOSSMAN_TEST_SLOW_FIRST_LAUNCH_MS (a test of this file, never set in CI) delays the first launch in the process by
// that many ms, and BOSSMAN_TEST_NO_WARM_UP skips the warm-up, to show a slow cold start fails the old way and passes
// with the warm-up.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { beforeAll, expect } from "vitest";

export const LAUNCH_DEADLINE_MS = 45_000;
export const LAUNCH_ATTEMPTS = 3;
const WARM_UP_HOOK_MS = LAUNCH_DEADLINE_MS * LAUNCH_ATTEMPTS + 15_000;
const SLOW_LOG_MS = 8_000;

type Launch = (opts?: { executablePath?: string; args?: string[]; timeout?: number }) => Promise<{ close: () => Promise<void> }>;
type Chromium = { launch: Launch; __bossmanPatched?: boolean; __bossmanLaunches?: number };

const say = (msg: string) => process.stderr.write(`browser-setup: ${msg}\n`);

export function patchedChromium(): Chromium | null {
  let chromium: Chromium;
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  if (chromium.__bossmanPatched) return chromium;
  chromium.__bossmanPatched = true;
  chromium.__bossmanLaunches = 0;
  const original = chromium.launch.bind(chromium);
  chromium.launch = async (opts = {}) => {
    const slowFirst = Number(process.env.BOSSMAN_TEST_SLOW_FIRST_LAUNCH_MS ?? 0);
    const first = (chromium.__bossmanLaunches = (chromium.__bossmanLaunches ?? 0) + 1) === 1;
    const args = [...new Set(["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter", `--crash-dumps-dir=${tmpdir()}`, ...(opts.args ?? [])])];
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      try {
        if (first && attempt === 1 && slowFirst > 0) await new Promise((r) => setTimeout(r, slowFirst));
        const browser = await original({ ...opts, args, timeout: opts.timeout ?? LAUNCH_DEADLINE_MS });
        const took = Date.now() - t0;
        if (took >= SLOW_LOG_MS) say(`chromium launch took ${(took / 1000).toFixed(1)} s (try ${attempt}, launch ${chromium.__bossmanLaunches})`);
        return browser;
      } catch (e) {
        // A path that is not there never works later: let the caller try the next candidate.
        if (attempt >= LAUNCH_ATTEMPTS || /doesn't exist|Executable/i.test(String((e as Error)?.message))) throw e;
        say(`chromium launch failed after ${((Date.now() - t0) / 1000).toFixed(1)} s (try ${attempt}): ${String((e as Error)?.message).split("\n")[0]?.slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  };
  return chromium;
}

// Only files that drive a browser pay for the warm-up.
const wantsBrowser = (file: string | undefined) => {
  if (!file || /browser-setup/.test(file)) return false;
  try {
    return /playwright/.test(readFileSync(file, "utf8")) || /from "\.\/real-page"/.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
};

// One shared default wait for every findBy* and waitFor (BOS-2298). Testing Library's own default is 1 s, and 1,060
// calls in 140 test files used it; GitHub's runners are 2.5 to 5 times slower than a dev machine, so a screen that
// draws in 300 ms here could miss 1 s there (BOS-2168, BOS-2234). A passing test is no slower: these calls return as
// soon as the thing shows up, the limit is only the longest they will wait. 5 s is 5 times the old default, and still
// well under the 30 s test timeout, so a screen that never draws still fails with Testing Library's message
// (what was missing and the page's HTML), not a bare timeout. A call that passes its own `timeout` keeps it.
export const ASYNC_UTIL_TIMEOUT_MS = 5_000;
try {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });
} catch {
  /* a file that doesn't use Testing Library needs no wait */
}

beforeAll(async () => {
  const file = expect.getState().testPath;
  if (!wantsBrowser(file)) return;
  const chromium = patchedChromium();
  if (!chromium) return;
  // Test knob for the slow-start proof only: the old behaviour (the cold start lands inside the first test).
  if (process.env.BOSSMAN_TEST_NO_WARM_UP) return;
  // Same candidates the tests try, first one that starts wins; none starting is the tests' own business (skip or fail there).
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      const browser = await chromium.launch(executablePath ? { executablePath } : {});
      await browser.close();
      return;
    } catch {
      /* next candidate */
    }
  }
}, WARM_UP_HOOK_MS);
