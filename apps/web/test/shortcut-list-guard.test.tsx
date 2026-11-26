// @vitest-environment jsdom
// Guards for the one shortcut list (BOS-2687): a key in the list does what its row says, a letter with no row
// does nothing, and a page that marks cards for j/k has a screen row (so it can't be left out of the "?" list).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shortcuts } from "../src/components/Shortcuts";
import { HELP_KEY, JUMPS, JUMP_PREFIX, SCREENS } from "../src/shortcut-list";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const press = (key: string) => fireEvent.keyDown(window, { key });

describe("shortcut list: each row's keys do what it says", () => {
  it("every jump row goes to its route", () => {
    for (const j of JUMPS) {
      const go = vi.fn();
      window.location.hash = "#/dashboard";
      const { unmount } = render(<Shortcuts go={go} hasProjects />);
      press(JUMP_PREFIX);
      press(j.key);
      expect(go, `g ${j.key}`).toHaveBeenCalledWith(j.to);
      unmount();
    }
  });

  it("the help key opens the list", () => {
    render(<Shortcuts go={() => {}} hasProjects />);
    press(HELP_KEY);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("every screen row's keys move or open as its action says, and the list shows the row's words", () => {
    for (const s of SCREENS) {
      document.body.innerHTML = "";
      const opened = vi.fn();
      const wrap = document.createElement("div");
      wrap.innerHTML = [1, 2, 3].map((n) => `<div data-shortcut-card tabindex="-1" id="c${n}"><a href="#x${n}" data-shortcut-open>Open ${n}</a></div>`).join("");
      document.body.appendChild(wrap);
      wrap.querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => (e.preventDefault(), opened(a.id || a.textContent))));
      window.location.hash = s.match.source.includes("features") ? "#/features" : s.match.source.includes("runs") ? "#/runs" : `#/${s.name.toLowerCase()}`;
      expect(s.match.test(window.location.hash), s.name).toBe(true);
      const { unmount } = render(<Shortcuts go={() => {}} hasProjects />);
      for (const row of s.rows) {
        const key = row.keys[0]!;
        if (row.action === "next") {
          press(key);
          expect(document.activeElement?.id, `${s.name} ${key}`).toBe("c1");
        } else if (row.action === "prev") {
          press(key);
          expect(document.activeElement?.id, `${s.name} ${key}`).toBe("c1"); // from card 1, stays at the start
        } else {
          press(key);
          expect(opened, `${s.name} ${key}`).toHaveBeenCalledTimes(1);
        }
      }
      press(HELP_KEY);
      const text = screen.getByRole("dialog", { name: "Keyboard shortcuts" }).textContent ?? "";
      expect(text).toContain(s.title);
      for (const row of s.rows) expect(text).toContain(row.what);
      unmount();
    }
  });

  it("a letter with no row does nothing", () => {
    const keys = new Set([JUMP_PREFIX, HELP_KEY, ...JUMPS.map((j) => j.key), ...SCREENS.flatMap((s) => s.rows.flatMap((r) => r.keys.map((k) => k.toLowerCase())))]);
    const go = vi.fn();
    const card = document.createElement("div");
    card.setAttribute("data-shortcut-card", "");
    card.tabIndex = -1;
    document.body.appendChild(card);
    render(<Shortcuts go={go} hasProjects />);
    const before = document.activeElement;
    for (const letter of "abcdefghijklmnopqrstuvwxyz".split("").filter((l) => !keys.has(l))) {
      press(letter);
      press(JUMP_PREFIX);
      press(letter);
    }
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(document.activeElement).toBe(before);
  });
});

describe("shortcut list: pages that mark cards have a screen row (reads repo files)", () => {
  it("every page file with data-shortcut-card is named by a screen row", () => {
    const pages = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "pages");
    const listed = new Set(SCREENS.map((s) => s.pageFile));
    const missing = readdirSync(pages, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx$/.test(f))
      .filter((f) => readFileSync(join(pages, f), "utf8").includes("data-shortcut-card"))
      .filter((f) => !listed.has(f));
    expect(missing, `page files that mark cards with data-shortcut-card but have no row in src/shortcut-list.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every screen row names a page file that exists and marks cards", () => {
    const pages = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "pages");
    for (const s of SCREENS) expect(readFileSync(join(pages, s.pageFile), "utf8"), s.pageFile).toContain("data-shortcut-card");
  });
});
