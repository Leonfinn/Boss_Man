// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Secrets } from "../src/pages/Secrets";
import { Credentials } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("secrets page", () => {
  it("is the one place to add, grant and list credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/companies/c1/grants"
          ? json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secret: "Boss Man Github token", hint: "Y1S4", deployTargetId: null, agentIds: [] }])
          : url === "/api/secrets"
            ? json([{ id: "s1", name: "Boss Man Github token", kind: "generic", hint: "Y1S4", version: 1, createdAt: "2026-10-19T17:22:00Z", updatedAt: "2026-10-19T17:22:00Z" }])
            : json([]),
      ),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    expect(await screen.findByRole("heading", { name: "Boss Man Co's variables" })).toBeTruthy();
    expect(await screen.findByText("GIT_TOKEN")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All stored secrets" })).toBeTruthy();
    expect((await screen.findAllByText("Boss Man Github token")).length).toBeGreaterThan(0);
  });

  it("shows a loader while the stored secrets load, not 'No secrets yet'", async () => {
    // Released at the end: the api layer shares one in-flight GET per URL, so a request left hanging would leak into the next test.
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string) => (url === "/api/secrets" ? new Promise<Response>((res) => (release = res)) : Promise.resolve(json([])))));
    render(<Secrets companies={[company]} companyId="c1" />);
    expect(await screen.findByText(/Loading the stored secrets/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/No secrets yet/)).toBeNull();
    release(json([]));
    expect(await screen.findByText(/No secrets yet/)).toBeTruthy();
  });

  it("says the stored secrets could not load, and Retry loads them", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/secrets"
          ? fail
            ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
            : json([{ id: "s1", name: "Stored one", kind: "generic", hint: null, version: 1, createdAt: "2026-10-19T17:22:00Z", updatedAt: "2026-10-19T17:22:00Z" }])
          : json([]),
      ),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    expect(await screen.findByText(/Couldn't load the stored secrets/)).toBeTruthy();
    expect(screen.queryByText(/No secrets yet/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Stored one")).toBeTruthy();
  });

  it("credentials list: loader while loading, error with Retry on failure, 'No credentials yet' only when empty", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string) => (url === "/api/companies/c1/grants" ? new Promise<Response>((res) => (release = res)) : Promise.resolve(json([])))));
    render(<Credentials company={company} />);
    expect(await screen.findByText(/Loading the credentials/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/No credentials yet/)).toBeNull();
    release(json([]));
    expect(await screen.findByText(/No credentials yet/)).toBeTruthy();
    cleanup();

    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/companies/c1/grants"
          ? fail
            ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
            : json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secretName: "Token", hint: null, deployTargetId: null, agentIds: [] }])
          : json([]),
      ),
    );
    render(<Credentials company={company} />);
    expect(await screen.findByText(/Couldn't load the credentials/)).toBeTruthy();
    expect(screen.queryByText(/No credentials yet/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("GIT_TOKEN")).toBeTruthy();
  });

  it("a secret's details: loader, then error with Retry, never 'Not granted' or 'No run' before the data is in", async () => {
    const secret = { id: "s1", name: "Stored one", kind: "generic", hint: null, version: 1, createdAt: "2026-10-19T17:22:00Z", updatedAt: "2026-10-19T17:22:00Z" };
    let failGrants = true;
    let releaseLog: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/secrets") return Promise.resolve(json([secret]));
        if (url === "/api/secrets/s1/grants")
          return Promise.resolve(failGrants ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }) : json([]));
        if (url.startsWith("/api/secrets/s1/access-log")) return new Promise<Response>((res) => (releaseLog = res));
        return Promise.resolve(json([]));
      }),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Stored one/ }));
    expect(await screen.findByText(/Couldn't load who gets this secret/)).toBeTruthy();
    // The Loader prints its words only after LOADER_DELAY_MS (1 s), so wait past that, with a deadline.
    expect(await screen.findByText(/Loading the recent use/, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/Not granted to any company/)).toBeNull();
    expect(screen.queryByText(/No run has been given it yet/)).toBeNull();
    failGrants = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Not granted to any company/)).toBeTruthy();
    releaseLog(json({ entries: [], summary: { total: 0, byCompany: [], byPurpose: { run: 0, deploy: 0, merge: 0, other: 0 }, perDay: new Array(30).fill(0) } }));
    expect(await screen.findByText(/No run has been given it yet/)).toBeTruthy();
    expect(screen.getByText(/Not read in the last 30 days/)).toBeTruthy();
    expect(screen.getByText(/Never used/)).toBeTruthy();
  });

  it("names the deploy target a secret is limited to, and falls back when it is unknown", async () => {
    const grant = (id: string, target: string) => ({ id, secretId: "s1", envName: `VAR_${id}`, secretName: "Token", hint: null, deployTargetId: target, agentIds: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/companies/c1/grants" ? json([grant("a", "t1"), grant("b", "gone")]) : url === "/api/companies/c1/deploy-targets" ? json([{ id: "t1", name: "Staging box" }]) : json([]),
      ),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Staging box")).toBeTruthy();
    expect(screen.getByText("One deploy target")).toBeTruthy();
  });

  it("removes a key from just this company", async () => {
    const calls: string[] = [];
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return url === "/api/companies/c1/grants"
          ? json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secretName: "Boss Man Github token", hint: "Y1S4", deployTargetId: null, agentIds: [] }])
          : json([]);
      }),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove GIT_TOKEN from Boss Man Co" }));
    await vi.waitFor(() => expect(calls).toContain("DELETE /api/grants/g1"));
    expect(calls).not.toContain("DELETE /api/secrets/s1");
  });
});

describe("agents per key", () => {
  it("saves which agents get a key", async () => {
    const calls: string[] = [];
    const agent = (id: string, name: string) => ({ id, companyId: "c1", name, role: "worker" as const, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null });
    const co: Company = { ...company, agents: [agent("a1", "Ada"), agent("a2", "Bo")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
        return url === "/api/companies/c1/grants" ? json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secretName: "Token", hint: "Y1S4", deployTargetId: null, agentIds: [] }]) : json([]);
      }),
    );
    render(<Secrets companies={[co]} companyId="c1" />);
    fireEvent.click(await screen.findByText("Every agent"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Bo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save agents for GIT_TOKEN" }));
    await vi.waitFor(() => expect(calls).toContain('PUT /api/grants/g1/agents {"agentIds":["a2"]}'));
  });
});

describe("Synthetic credential", () => {
  it("offers the Synthetic API key under the synthetic/<model> help text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<Credentials company={company} />);
    const kind = (await screen.findByLabelText("Add")) as HTMLSelectElement;
    const synthetic = Array.from(kind.options).find((o) => o.text === "Synthetic API key");
    expect(synthetic?.value).toBeTruthy();
    fireEvent.change(kind, { target: { value: synthetic!.value } });
    await vi.waitFor(() => expect((screen.getByLabelText("Variable name") as HTMLInputElement).value).toBe("SYNTHETIC_API_KEY"));
    expect(screen.getByText(/Models are named synthetic\/<model>/)).toBeTruthy();
  });
});

describe("adding a credential", () => {  it("starts with no kind chosen and points a pasted JSON key at Other", async () => {
    const posts: Array<{ url: string; body: { name?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
        return json(init?.method === "POST" && url === "/api/secrets" ? { secret: { id: "s9" }, warnings: [] } : init?.method === "POST" ? {} : []);
      }),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    const kind = (await screen.findByLabelText("Add")) as HTMLSelectElement;
    expect(kind.value).toBe("");
    expect(kind.required).toBe(true);
    expect((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(kind, { target: { value: "0" } }); // Claude setup-token
    fireEvent.change(screen.getAllByLabelText("Value").at(-1)!, { target: { value: '{"type": "service_account", "private_key": "x"}' } });
    expect(screen.getByRole("alert").textContent).toContain("looks like a JSON key file");

    fireEvent.change(kind, { target: { value: String(Array.from(kind.options).findIndex((o) => o.text === "Other") - 1) } });
    expect(screen.queryByText(/looks like a JSON key file/)).toBeNull();

    // A blank name under Other takes the variable name, so it isn't typed twice.
    fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "GSC_SERVICE_ACCOUNT_JSON" } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).placeholder).toBe("GSC_SERVICE_ACCOUNT_JSON");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(posts.find((p) => p.url === "/api/secrets")?.body.name).toBe("GSC_SERVICE_ACCOUNT_JSON"));
    // The next one starts blank: no kind, no variable name carried over.
    await vi.waitFor(() => expect((screen.getByLabelText("Variable name") as HTMLInputElement).value).toBe(""));
    expect(kind.value).toBe("");
  });
});
