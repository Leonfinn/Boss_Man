import { describe, expect, it } from "vitest";
import { art, installIcons } from "../src/brand";

// The owner's artwork and the icons added at start-up. Pins which illustrations exist and that each is a real
// asset the bundler could resolve, and that the favicon and touch icon are added exactly once with the right sizes.

type FakeLink = { tag: string; rel?: string; href?: string; attrs: Record<string, string>; setAttribute: (k: string, v: string) => void };
type FakeDoc = { head: { children: FakeLink[]; appendChild: (el: FakeLink) => void }; createElement: (tag: string) => FakeLink };

function fakeDoc(): FakeDoc {
  const head = {
    children: [] as FakeLink[],
    appendChild(el: FakeLink) {
      head.children.push(el);
    },
  };
  return {
    head,
    createElement(tag: string): FakeLink {
      const el: FakeLink = {
        tag,
        attrs: {},
        setAttribute(k: string, v: string) {
          el.attrs[k] = v;
        },
      };
      return el;
    },
  };
}

describe("art", () => {
  it("has every illustration a screen asks for, each one a resolved asset", () => {
    expect(Object.keys(art).sort()).toEqual(["busy", "done", "logo", "mark64", "setup", "stuck"]);
    for (const [name, src] of Object.entries(art)) {
      expect(typeof src, name).toBe("string");
      expect(src.length, name).toBeGreaterThan(0);
      expect(src, name).toMatch(/\.(webp|png)$/);
    }
  });

  it("keeps each illustration apart, so a screen can't get the wrong picture", () => {
    expect(new Set(Object.values(art)).size).toBe(Object.values(art).length);
  });
});

describe("installIcons", () => {
  it("adds a 32x32 favicon and a touch icon, in that order", () => {
    const doc = fakeDoc();
    installIcons(doc as unknown as Document);

    expect(doc.head.children).toHaveLength(2);
    const [icon, touch] = doc.head.children as [FakeLink, FakeLink];
    expect(icon.tag).toBe("link");
    expect(icon.rel).toBe("icon");
    expect(icon.href).toMatch(/favicon\.ico$/);
    expect(icon.attrs.sizes).toBe("32x32");
    expect(touch.tag).toBe("link");
    expect(touch.rel).toBe("apple-touch-icon");
    expect(touch.href).toMatch(/boss-mark-180\.png$/);
    expect(touch.attrs.sizes).toBeUndefined();
  });

  it("adds nothing to the head beyond the two icons", () => {
    const doc = fakeDoc();
    installIcons(doc as unknown as Document);

    expect(doc.head.children.map((c) => c.rel)).toEqual(["icon", "apple-touch-icon"]);
  });
});
