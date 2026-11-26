// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseNotice } from "../src/pages/settings/ReleaseNotice";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2663: the Updates panel line for a new release of an image install, and its two switches.

afterEach(cleanup);

const base = { active: true, current: "0.1.0-beta.2", channel: "beta", enabled: true, ntfy: false, checkedAt: "2026-11-26T10:00:00Z", couldntCheck: false };
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
