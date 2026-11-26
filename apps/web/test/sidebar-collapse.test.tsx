// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";

// The side menu collapses to an icon-only strip (BOS-290): the toggle flips aria-expanded, icons
// keep their accessible name and link, the current page stays marked, badges survive, and on a
// narrow screen the expanded menu folds away after choosing a page or tapping outside.
afterEach(cleanup);

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };

function show(opts: { collapsed?: boolean; narrow?: boolean; onToggleCollapsed?: () => void } = {}) {
  const onToggleCollapsed = opts.onToggleCollapsed ?? vi.fn();
  render(
    <Sidebar
      active="projects"
      companies={[company]}
      current={company}
      decisions={[]}
      unread={3}
      feedback={2}
      mergeWaiting={0}
      mergeStuck={0}
      notifications="unsupported"
      collapsed={opts.collapsed ?? false}
      narrow={opts.narrow ?? false}
      onToggleCollapsed={onToggleCollapsed}
      onPickCompany={() => {}}
      onCreateCompany={async () => {}}
      onEnableNotifications={() => {}}
      onLogout={() => {}}
    />,
  );
  return { onToggleCollapsed };
}

describe("side menu collapse toggle", () => {
  it("shows an expand button while collapsed and a collapse button while expanded", () => {
    show({ collapsed: true });
    expect(screen.getByRole("button", { name: "Expand menu" }).getAttribute("aria-expanded")).toBe("false");
    cleanup();
    show({ collapsed: false });
    expect(screen.getByRole("button", { name: "Collapse menu" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("asks App to flip the strip when the toggle is pressed", () => {
    const { onToggleCollapsed } = show({ collapsed: false });
    fireEvent.click(screen.getByRole("button", { name: "Collapse menu" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("marks the strip so the stylesheet can drop the labels", () => {
    const { container } = render(
      <Sidebar active="projects" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} notifications="unsupported" collapsed narrow={false} onToggleCollapsed={() => {}} onPickCompany={() => {}} onCreateCompany={async () => {}} onEnableNotifications={() => {}} onLogout={() => {}} />,
    );
    expect(container.querySelector("nav.side")?.className).toContain("collapsed");
  });
});

describe("collapsed icons still work", () => {
  it("keeps each icon's accessible name, link and the current page highlight", () => {
    show({ collapsed: true });
    const dashboard = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboard.getAttribute("href")).toBe("#/dashboard");
    expect(dashboard.getAttribute("title")).toBe("Dashboard (g then d)");
    expect(dashboard.getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the Feedback and Notifications badges with a readable count", () => {
    show({ collapsed: true });
    // Feedback sits in the Product group (BOS-1506): the strip's row carries its count, the panel the page.
    expect(within(screen.getByRole("button", { name: /^Product/ })).getByLabelText("2 to process").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: /^Product/ }));
    const feedback = screen.getByRole("link", { name: /^Feedback/ });
    expect(within(feedback).getByLabelText("2 to process").textContent).toBe("2");
    const notifications = screen.getByRole("link", { name: /^Notifications/ });
    expect(within(notifications).getByLabelText("3 unread").textContent).toBe("3");
    // A dot is drawn for the strip too, but it is decorative, not read out.
    expect(feedback.querySelector(".count-dot")).not.toBeNull();
  });

  it("keeps Log out reachable as a named button with an icon while collapsed", () => {
    show({ collapsed: true });
    const logout = screen.getByRole("button", { name: "Log out" });
    expect(logout.getAttribute("title")).toBe("Log out");
    expect(logout.querySelector(".logout-icon")).not.toBeNull();
  });
});

describe("narrow screen overlay", () => {
  it("folds the expanded menu away after choosing a page", () => {
    const { onToggleCollapsed } = show({ collapsed: false, narrow: true });
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("folds the expanded menu away when the owner taps outside it", () => {
    const { onToggleCollapsed } = show({ collapsed: false, narrow: true });
    fireEvent.mouseDown(document.body);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("stays open when the tap lands inside the menu", () => {
    const { onToggleCollapsed } = show({ collapsed: false, narrow: true });
    fireEvent.mouseDown(screen.getByRole("link", { name: "Dashboard" }));
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("does not close a desktop menu after choosing a page", () => {
    const { onToggleCollapsed } = show({ collapsed: false, narrow: false });
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });
});
