import { describe, expect, it } from "vitest";
import { layoutPlan } from "../src/index.js";

const node = (id: string, open: boolean) => ({ id, open });
const edge = (from: string, to: string) => ({ from, to });

describe("layoutPlan", () => {
  it("lays a chain of blockers out in layers 0, 1, 2", () => {
    const l = layoutPlan([node("a", true), node("b", true), node("c", true)], [edge("a", "b"), edge("b", "c")]);
    expect(l.layer).toMatchObject({ a: 0, b: 1, c: 2 });
    expect(l.columns.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it("counts an open blocker even when the node in between is closed", () => {
    // a is open, b is closed, c waits on b: both b and c are held up by a.
    const l = layoutPlan([node("a", true), node("b", false), node("c", false)], [edge("a", "b"), edge("b", "c")]);
    expect([...l.blocked].sort()).toEqual(["b", "c"]);
    expect(l.causes.c).toEqual(["a"]);
    expect(l.holdingUp.a).toBe(2);
  });

  it("leaves a blocked node out of causes but still counts it as held up", () => {
    // a and b are both open; b is itself blocked by a, so it is not a head of c's chains.
    const l = layoutPlan([node("a", true), node("b", true), node("c", false)], [edge("a", "b"), edge("b", "c")]);
    expect(l.causes.c).toEqual(["a"]);
    expect(l.holdingUp.a).toBe(2);
    expect(l.holdingUp.b).toBe(1);
  });

  it("lets a closed blocker block nothing", () => {
    const l = layoutPlan([node("a", false), node("b", true)], [edge("a", "b")]);
    expect(l.blocked.size).toBe(0);
    expect(l.blocked.has("b")).toBe(false);
    expect(l.causes).toEqual({});
  });

  it("ignores an edge to an unknown node and an edge from a node to itself", () => {
    const l = layoutPlan(
      [node("a", true), node("b", true)],
      [edge("x", "a"), edge("a", "x"), edge("a", "a"), edge("a", "b")],
    );
    expect(Object.keys(l.layer).sort()).toEqual(["a", "b"]);
    expect(l.layer).toMatchObject({ a: 0, b: 1 });
    // The self-edge must not make a block itself.
    expect(l.blocked.has("a")).toBe(false);
    expect(l.blocked.has("b")).toBe(true);
  });

  it("survives a cycle and still gives every node a layer", () => {
    let l!: ReturnType<typeof layoutPlan>;
    expect(() => {
      l = layoutPlan([node("a", true), node("b", true)], [edge("a", "b"), edge("b", "a")]);
    }).not.toThrow();
    expect(Object.keys(l.layer).sort()).toEqual(["a", "b"]);
    expect(typeof l.layer.a).toBe("number");
    expect(typeof l.layer.b).toBe("number");
  });

  it("puts every node in exactly one column", () => {
    const l = layoutPlan(
      [node("a", true), node("b", false), node("c", false), node("d", true)],
      [edge("a", "b"), edge("b", "c")],
    );
    const flat = l.columns.flat();
    expect(flat.slice().sort()).toEqual(["a", "b", "c", "d"]);
    expect(new Set(flat).size).toBe(flat.length);
  });
});
