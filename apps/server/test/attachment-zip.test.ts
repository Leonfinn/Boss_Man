// BOS-228: a zip the owner attaches (a company export) is read server-side as a safe listing plus its text
// files, without trusting it: ../ paths, a zip bomb's declared size and too many entries are refused, and a
// binary entry is listed by name and size only.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { readZip, ZIP_LIMITS } from "../src/services/attachment-zip.js";

let done: () => Promise<void> = async () => {};
afterEach(() => done());

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  done = async () => (await built.app.close(), await close());
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: randomUUID() })}` } } }));
  const upload = async (bytes: Buffer, name: string) => (await req("POST", `/api/companies/${company.id}/images`, { data: bytes.toString("base64"), name })).json() as { id: string; markdown: string };
  const open = async (id: string, offset?: number) => (await client.callTool({ name: "open_attachment", arguments: { id, ...(offset !== undefined ? { offset } : {}) } })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  return { req, company, upload, open, client };
}

/** A zip whose central directory can declare any name, size and method, whatever the data says. */
function crafted(entries: Array<{ name: string; data?: Uint8Array; declaredSize?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0);
    const size = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(size, 22); // uncompressed size, as declared (can lie)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(size, 24);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const SKILLS = JSON.stringify([{ name: "release" }, { name: "audit" }]);

describe("a zip the owner attaches (BOS-228)", () => {
  it("reads a company export's text files through open_attachment", async () => {
    const c = await setup();
    const zip = Buffer.from(
      zipSync({
        "boss-man-co.bossman/manifest.json": strToU8('{"format":"bossman-company"}'),
        "boss-man-co.bossman/skills.json": strToU8(SKILLS),
        "boss-man-co.bossman/skills/release/SKILL.md": strToU8("# Release\n\nShip it.\n"),
        "boss-man-co.bossman/assets/badge.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      }),
    );
    const up = await c.upload(zip, "boss-man-co.bossman.zip");
    expect(up.markdown).toBe(`[📎 boss-man-co.bossman.zip](/api/ticket-images/${up.id})`);
    const got = await c.open(up.id);
    expect(got.isError).toBeFalsy();
    const out = got.content[0]!.text!;
    expect(out).toContain('"format":"bossman-company"');
    expect(out).toContain(SKILLS);
    expect(out).toContain("# Release");
    // The picture is listed by name and size only, never dumped.
    expect(out).toContain("assets/badge.png (8 bytes)");
    expect(out).not.toContain("PNG");
    await c.client.close();
  });

  it("refuses a zip with ../ paths, a zip bomb and too many entries with a clear message", async () => {
    const c = await setup();
    const refuse = async (zip: Buffer, why: RegExp) => {
      const up = await c.upload(zip, "export.zip");
      const got = await c.open(up.id);
      expect(got.isError).toBe(true);
      expect(got.content[0]!.text).toMatch(why);
    };
    await refuse(crafted([{ name: "../../etc/passwd", data: strToU8("x") }]), /unsafe entry/);
    // A tiny deflated file that claims to unpack to 1 GB: refused from the index, before anything is inflated.
    const bomb = crafted([{ name: "big.txt", data: Buffer.alloc(0), declaredSize: 1024 * 1024 * 1024 }]);
    await refuse(bomb, /unpacks to .* MB/);
    const many = crafted(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}.txt`, data: strToU8("x") })));
    await refuse(many, /reads at most 5000/);
    await c.client.close();
  });

  it("caps an entry whose header lies about its size instead of growing with it", () => {
    // The header says 10 bytes; the deflate stream inflates to more than the per-entry cap. An archive that
    // understates its size must not make the reader hold a huge file: the entry is listed, never dumped.
    const zip = Buffer.from(zipSync({ "lie.txt": strToU8("a".repeat(ZIP_LIMITS.entryBytes + 1024 * 1024)) }, { level: 1 }));
    // Rewrite the declared size in both headers to something small, as a malicious archive would.
    zip.writeUInt32LE(10, 22);
    zip.writeUInt32LE(10, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    const out = readZip(zip);
    // It is named in the listing, but the inflated megabyte is not returned.
    expect(out).toContain("lie.txt");
    expect(out).not.toContain("a".repeat(1000));
  });

  it("still opens pictures, PDFs and plain text as before", async () => {
    const c = await setup();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const pic = await c.upload(png, "shot.png");
    expect((await c.open(pic.id)).content[0]).toMatchObject({ type: "image" });
    const txt = await c.upload(Buffer.from("hello"), "notes.txt");
    expect((await c.open(txt.id)).content[0]!.text).toBe("notes.txt\n\nhello");
    const pdf = await c.upload(Buffer.from("%PDF-1.4 fake"), "spec.pdf");
    expect((await c.open(pdf.id)).content[0]).toMatchObject({ type: "resource" });
    await c.client.close();
  });
});
