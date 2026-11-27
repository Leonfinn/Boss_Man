// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseNotice } from "../src/pages/settings/ReleaseNotice";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2663: the Updates panel line for a new release of an image install, and its two switches.

afterEach(cleanup);

const base = { active: true, current: "0.1.0-beta.2", channel: "beta", enabled: true, ntfy: false, checkedAt: "2026-11-26T10:00:00Z", couldntCheck: false, install: { linked: true, updater: null } };
const available = { version: "0.1.0-beta.3", url: "https://github.com/example-org/boss-man/releases/tag/v0.1.0-beta.3", summary: "Faster updates.", publishedAt: null, prerelease: true };

describe("ReleaseNotice", () => {
  it("shows nothing on a source install", async () => {
    const f = stubFetchByUrl({ "/api/release-watch": { active: false } });
    const { container } = render(<ReleaseNotice />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("names the version, says what is in it and links the notes", async () => {
    stubFetchByUrl({ "/api/release-watch": { ...base, available } });
    render(<ReleaseNotice />);
    expect(await screen.findByText(/Boss Man 0\.1\.0-beta\.3 is available/)).toBeTruthy();
    expect(screen.getByTestId("release-notice").textContent).toContain("Faster updates.");
    expect(screen.getByRole("link", { name: "Release notes" }).getAttribute("href")).toBe(available.url);
  });

  it("says couldn't check quietly, as a plain line and not an alert", async () => {
    stubFetchByUrl({ "/api/release-watch": { ...base, couldntCheck: true, available: null } });
    render(<ReleaseNotice />);
    expect(await screen.findByText(/Couldn't check for a new release just now/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // BOS-2713: the Install button sends the version on offer, and the line shows what the updater is doing.
  it("Install sends the version shown, and a refusal reads as a plain sentence", async () => {
    const posts: unknown[] = [];
    stubFetchByUrl({
      "/api/release-watch": { ...base, available },
      "/api/release-watch/install": (_u: string, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ error: "An update is already running. Its progress is shown here." }), { status: 409, headers: { "content-type": "application/json" } });
      },
    });
    render(<ReleaseNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "Install 0.1.0-beta.3" }));
    await waitFor(() => expect(posts).toEqual([{ version: "0.1.0-beta.3" }]));
    expect((await screen.findByRole("alert")).textContent).toContain("An update is already running");
  });

  it("while the updater works: progress in plain words, no Install button", async () => {
    stubFetchByUrl({ "/api/release-watch": { ...base, available, install: { linked: true, updater: { stage: "pulling", version: "0.1.0-beta.3", error: null, report: null } } } });
    render(<ReleaseNotice />);
    expect(await screen.findByText(/Downloading the new version/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
  });

  it("an install made before the link existed is told to install by hand, with no dead button", async () => {
    stubFetchByUrl({ "/api/release-watch": { ...base, available, install: { linked: false, updater: null } } });
    render(<ReleaseNotice />);
    expect(await screen.findByText(/install this release by hand/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
  });

  it("a finished move can be dismissed with Got it", async () => {
    const posts: string[] = [];
    stubFetchByUrl({
      "/api/release-watch": { ...base, available: null, install: { linked: true, updater: { stage: "done", version: "0.1.0-beta.3", error: null, report: { level: "info", text: "Updated to 0.1.0-beta.3.", acknowledged: false } } } },
      "/api/release-watch/ack": () => {
        posts.push("ack");
        return {};
      },
    });
    render(<ReleaseNotice />);
    expect(await screen.findByText(/Updated to 0\.1\.0-beta\.3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(posts).toEqual(["ack"]));
  });

  it("turns the daily check off, and the phone push on", async () => {
    const puts: unknown[] = [];
    stubFetchByUrl({
      "/api/release-watch": (_u: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return { ...base, available: null };
        }
        return { ...base, available: null };
      },
    });
    render(<ReleaseNotice />);
    fireEvent.click(await screen.findByLabelText("Also send it to my phone"));
    fireEvent.click(screen.getByLabelText("Tell me about new releases"));
    await waitFor(() => expect(puts).toEqual([{ ntfy: true }, { enabled: false }]));
  });
});
