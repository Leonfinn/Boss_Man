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
