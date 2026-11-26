// @vitest-environment jsdom
// BOS-2688: the menu's keyboard button opens the "?" list and focus returns to it; menu links carry their
// jump key in the tooltip; the list shows this page's keys first, then "Everywhere".
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Company } from "../src/api";
import { Shortcuts } from "../src/components/Shortcuts";
import { Sidebar } from "../src/components/Sidebar";
import { JUMPS, linkTitle } from "../src/shortcut-list";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
const noop = () => {};
const show = () =>
  render(
    <>
      <Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />
      <Shortcuts go={noop} hasProjects={false} />
    </>,
  );

describe("the menu's keyboard button", () => {
  it("opens the list, and closing puts focus back on the button", () => {
    show();
    const button = screen.getByRole("button", { name: "Keyboard shortcuts (?)" });
    expect(button.getAttribute("title")).toBe("Keyboard shortcuts (?)");
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("sits between Settings and Log out", () => {
    show();
    const row = screen.getByRole("button", { name: "Keyboard shortcuts (?)" }).parentElement!;
    const names = [...row.children].map((c) => c.getAttribute("aria-label") ?? c.textContent?.trim());
    expect(names.map((n) => n?.replace(/\s+/g, " "))).toEqual(["Settings", "Keyboard shortcuts (?)", "Log out"]);
  });
});

describe("key hints in menu tooltips", () => {
  it("every jump key's page link says its key, and links with no key stay plain", () => {
    show();
    expect(screen.getByRole("link", { name: "Decisions" }).getAttribute("title")).toBe("Decisions (g then i)");
    expect(screen.getByRole("link", { name: "Projects" }).getAttribute("title")).toBe("Projects (g then b)");
    expect(screen.getByRole("link", { name: "Merge queue" }).getAttribute("title")).toBe("Merge queue");
    for (const j of JUMPS.filter((x) => x.key !== "b")) expect(linkTitle(j.to, j.label)).toBe(`${j.label} (g then ${j.key})`);
  });
});

describe("the list's order", () => {
  it("puts this page's keys before Everywhere", () => {
    window.location.hash = "#/board/p1";
    show();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts (?)" }));
    const heads = [...screen.getByRole("dialog").querySelectorAll("h3")].map((h) => h.textContent);
    expect(heads).toEqual(["On the Board", "Everywhere"]);
  });

  it("starts with the everywhere keys on a page with no keys of its own", () => {
    window.location.hash = "#/wiki";
    show();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts (?)" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll("h3")).toHaveLength(0);
    expect(dialog.querySelector("dl")?.getAttribute("aria-label")).toBe("Everywhere");
  });
});
