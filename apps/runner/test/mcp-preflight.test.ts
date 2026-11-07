import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mcpPreflight } from "../src/mcp-preflight.js";

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.closeAllConnections(), s.close(); });

async function stub(handler: (n: number, res: http.ServerResponse) => void): Promise<string> {
  let n = 0;
  const s = http.createServer((req, res) => { req.resume(); handler(++n, res); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp`;
}
const ok = (res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };

describe("mcpPreflight", () => {
  it("waits out a 6 s stall on the first request and then succeeds", async () => {
    const url = await stub((n, res) => (n === 1 ? void setTimeout(() => res.destroyed || ok(res), 6000) : ok(res)));
    const r = await mcpPreflight(url, "t");
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  }, 20_000);

  it("gives up after its budget when the server never answers", async () => {
    const url = await stub((_n, res) => void (res.statusCode = 503, res.end()));
    const r = await mcpPreflight(url, "t", { budgetMs: 600, delayMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.lastError).toBe("HTTP 503");
  });

  it("treats a refused token as an answer (the server is up)", async () => {
    const url = await stub((_n, res) => void (res.statusCode = 401, res.end()));
    expect((await mcpPreflight(url, "t", { budgetMs: 600 })).ok).toBe(true);
  });
});
