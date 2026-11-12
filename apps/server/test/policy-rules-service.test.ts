// The permission-rules service's own refusals (BOS-1107). Route and MCP tests use the service, but
// nothing calls it directly: a missing rule on update or remove is a 404, an invalid match is a 422,
// and a reorder that doesn't list each of the scope's rules exactly once is a 422 that changes nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";
import { RuleError, policyRulesService } from "../src/services/policy-rules.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const [a] = await db.insert(companies).values({ name: "Company A" }).returning();
  const [b] = await db.insert(companies).values({ name: "Company B" }).returning();
  const rules = policyRulesService(db);
  const add = (companyId: string | null, name: string) =>
    rules.create({ companyId, name, match: { titlePattern: `^${name}$` }, outcome: "allow" });
  return { db, close, rules, companyA: a!.id, companyB: b!.id, add };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(RuleError);
    return (e as RuleError).status;
  }
  return undefined;
}

const order = async (companyId: string) => (await ctx.rules.list(companyId)).company.map((r) => r.name);

describe("policy rules service (BOS-1107)", () => {
  it("returns a created rule from the list for its scope", async () => {
    const made = await ctx.add(ctx.companyA, "Allow GitHub reads");
    const listed = await ctx.rules.list(ctx.companyA);
    expect(listed.company).toEqual([made]);
    expect(listed.global).toEqual([]);
    // It stays in its own scope: another company doesn't see it.
    expect((await ctx.rules.list(ctx.companyB)).company).toEqual([]);
  });

  it("refuses an update or remove of an unknown rule with 404", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await statusOf(ctx.rules.update(missing, { name: "Renamed" }))).toBe(404);
    expect(await statusOf(ctx.rules.remove(missing))).toBe(404);
  });

  it("refuses a match the checker rejects with 422", async () => {
    expect(
      await statusOf(
        ctx.rules.create({ companyId: ctx.companyA, name: "No condition", match: {}, outcome: "allow" }),
      ),
    ).toBe(422);
    expect(
      await statusOf(
        ctx.rules.create({
          companyId: ctx.companyA,
          name: "Bad kind",
          match: { kinds: ["teleport" as never] },
          outcome: "allow",
        }),
      ),
    ).toBe(422);
    expect((await ctx.rules.list(ctx.companyA)).company).toEqual([]);
  });

  it("refuses a reorder with a missing, repeated or other-scope rule and keeps the order", async () => {
    const first = await ctx.add(ctx.companyA, "First");
    const second = await ctx.add(ctx.companyA, "Second");
    const other = await ctx.add(ctx.companyB, "Other scope");
    expect(await order(ctx.companyA)).toEqual(["First", "Second"]);

    // One of the scope's rules is missing.
    expect(await statusOf(ctx.rules.reorder(ctx.companyA, [second.id]))).toBe(422);
    // A rule listed twice.
    expect(await statusOf(ctx.rules.reorder(ctx.companyA, [first.id, first.id]))).toBe(422);
    // An id that belongs to another scope.
    expect(await statusOf(ctx.rules.reorder(ctx.companyA, [first.id, other.id]))).toBe(422);

    expect(await order(ctx.companyA)).toEqual(["First", "Second"]);
  });

  it("sets the order when every rule of the scope is listed once", async () => {
    const first = await ctx.add(ctx.companyA, "First");
    const second = await ctx.add(ctx.companyA, "Second");
    const reordered = await ctx.rules.reorder(ctx.companyA, [second.id, first.id]);
    expect(reordered.map((r) => r.name)).toEqual(["Second", "First"]);
    expect(await order(ctx.companyA)).toEqual(["Second", "First"]);
  });
});
