// screenshot.mjs --click / --wait-after (BOS-2547). A fake page records the calls, so this needs no browser:
// GitHub's script-test job (node --test scripts/*.test.mjs in ci.yml's check job) installs no Playwright.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { afterLoad, parseArgs } from "./screenshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Selectors in `missing` never appear; selectors in `unclickable` appear but the click throws.
function fakePage({ missing = [], unclickable = [] } = {}) {
  const calls = [];
  return {
    calls,
    async waitForSelector(sel, opts) {
      calls.push(["wait", sel, opts.state, opts.timeout]);
      if (missing.includes(sel)) throw new Error(`Timeout ${opts.timeout}ms exceeded.\n=========================== logs`);
    },
    async click(sel) {
      calls.push(["click", sel]);
      if (unclickable.includes(sel)) throw new Error("element is not enabled\nCall log:\n  - waiting for locator");
    },
    keyboard: {
      async press(key) {
        calls.push(["press", key]);
      },
    },
    async screenshot(opts) {
      calls.push(["screenshot", opts.path]);
    },
  };
}

const base = ["--wait", "#page", "--out", "/nonexistent-dir-bos2547/shot.png"];

test("--click is repeatable and kept in order; --wait-after is optional", () => {
  assert.deepEqual(parseArgs(base).clicks, []);
  assert.equal(parseArgs(base).waitAfter, undefined);
  const o = parseArgs([...base, "--click", "#b", "--click", "#a", "--wait-after", ".done"]);
  assert.deepEqual(o.clicks, ["#b", "#a"]);
  assert.equal(o.waitAfter, ".done");
  assert.throws(() => parseArgs([...base, "--click"]), /--click needs a value/);
  assert.throws(() => parseArgs([...base, "--wait-after"]), /--wait-after needs a value/);
});

test("waits for --wait, then waits for and clicks each --click in order, then waits for --wait-after", async () => {
  const page = fakePage();
  const o = parseArgs([...base, "--timeout", "1234", "--click", "#tab", "--click", "#run", "--wait-after", ".result"]);
  await afterLoad(page, o, "http://127.0.0.1:1/#x");
  assert.deepEqual(page.calls, [
    ["wait", "#page", "visible", 1234],
    ["wait", "#tab", "visible", 1234],
    ["click", "#tab"],
    ["wait", "#run", "visible", 1234],
    ["click", "#run"],
    ["wait", ".result", "visible", 1234],
  ]);
});

test("--key is repeatable and pressed in order after the clicks and before --wait-after (BOS-2690)", async () => {
  assert.deepEqual(parseArgs(base).keys, []);
  const page = fakePage();
  const o = parseArgs([...base, "--click", "#tab", "--key", "Tab", "--key", "Control+k", "--wait-after", ".tip"]);
  await afterLoad(page, o, "http://127.0.0.1:1/#x");
  assert.deepEqual(page.calls, [
    ["wait", "#page", "visible", 20000],
    ["wait", "#tab", "visible", 20000],
    ["click", "#tab"],
    ["press", "Tab"],
    ["press", "Control+k"],
    ["wait", ".tip", "visible", 20000],
  ]);
  assert.throws(() => parseArgs([...base, "--key"]), /--key needs a value/);
});

test("a --click selector that never appears fails with one line naming it, keeps OUT.failed.png and clicks nothing after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-shot-test-"));
  try {
    const out = join(dir, "sub", "shot.png");
    const page = fakePage({ missing: ["#run"] });
    const o = parseArgs(["--wait", "#page", "--out", out, "--timeout", "500", "--click", "#tab", "--click", "#run", "--click", "#later"]);
    await assert.rejects(afterLoad(page, o, "http://t/#x"), (e) => {
      assert.equal(e.message, '--click "#run" did not appear within 500 ms at http://t/#x');
      return true;
    });
    assert.deepEqual(page.calls.at(-1), ["screenshot", `${out}.failed.png`]);
    assert.ok(existsSync(join(dir, "sub")), "the out folder is made so the failed shot can be written");
    assert.ok(!page.calls.some((c) => c[1] === "#later"), "no step runs after the failing one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--wait and --wait-after failures name their selector; the --wait line is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-shot-test-"));
  try {
    const out = join(dir, "shot.png");
    await assert.rejects(afterLoad(fakePage({ missing: ["#page"] }), parseArgs(["--wait", "#page", "--out", out, "--timeout", "500"]), "U"), {
      message: '"#page" did not appear within 500 ms at U',
    });
    await assert.rejects(afterLoad(fakePage({ missing: [".result"] }), parseArgs(["--wait", "#page", "--out", out, "--timeout", "500", "--wait-after", ".result"]), "U"), {
      message: '--wait-after ".result" did not appear within 500 ms at U',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a click that throws becomes one line naming the selector", async () => {
  const o = parseArgs([...base, "--click", "#off"]);
  await assert.rejects(afterLoad(fakePage({ unclickable: ["#off"] }), o, "U"), (e) => {
    assert.equal(e.message, '--click "#off" could not be clicked at U: element is not enabled');
    return true;
  });
});

test("run as a script it still parses options (importing it above did not start a capture)", () => {
  let err = "";
  try {
    execFileSync(process.execPath, [join(here, "screenshot.mjs"), "--click", "#a", "--out", "x.png"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    err = e.stderr;
    assert.equal(e.status, 1);
  }
  assert.match(err, /^screenshot: --wait SELECTOR is required/);
});
