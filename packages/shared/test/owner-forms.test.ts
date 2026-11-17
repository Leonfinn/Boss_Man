import { describe, expect, it } from "vitest";
import { OWNER_CONTROLS, OWNER_FIELDS, type OwnerScreen } from "../src/owner-controls.js";
import { OWNER_FORMS, type OwnerForm, type OwnerFormField } from "../src/owner-forms.js";

// The owner forms a card may send the owner to (DR-057, BOS-1285). The server's R18 lint looks a
// step up here, so a field or screen that drifts out of this registry stops a card before it reaches
// the owner. These tests pin the registry itself; apps/server's registry test reads the web forms.

const fieldsOf = (form: OwnerForm): OwnerFormField[] => [
  ...form.required,
  ...(form.groups ?? []).flatMap((g) => g.fields),
  ...(form.notChecked ?? []),
];

const byId = (id: string): OwnerForm => {
  const form = OWNER_FORMS.find((f) => f.id === id);
  if (!form) throw new Error(`OWNER_FORMS has no form "${id}"`);
  return form;
};

describe("OWNER_FORMS registry", () => {
  it("lists the three forms cards point at, in order", () => {
    expect(OWNER_FORMS.map((f) => f.id)).toEqual(["deployTarget", "toolServer", "secret"]);
  });

  it("has a unique id and a unique name for every form", () => {
    expect(new Set(OWNER_FORMS.map((f) => f.id)).size).toBe(OWNER_FORMS.length);
    expect(new Set(OWNER_FORMS.map((f) => f.name)).size).toBe(OWNER_FORMS.length);
  });

  it("sends every form to a screen the owner-card lint knows", () => {
    for (const form of OWNER_FORMS) {
      expect(Object.keys(OWNER_CONTROLS), form.id).toContain(form.screen);
    }
  });

  it("writes every path as a Settings screen, so a step can name it", () => {
    for (const form of OWNER_FORMS) {
      expect(form.path, form.id).toMatch(/^Settings → \S/);
      expect(form.name, form.id).toMatch(/\S/);
    }
  });

  it("matches every form by at least one word, whole and lower-case", () => {
    for (const form of OWNER_FORMS) {
      expect(form.names.length, form.id).toBeGreaterThan(0);
      expect(new Set(form.names).size, form.id).toBe(form.names.length);
      for (const name of form.names) {
        expect(name, `${form.id}: "${name}"`).toBe(name.trim().toLowerCase());
        expect(name, `${form.id}: "${name}"`).not.toBe("");
      }
    }
  });

  it("requires at least one field on every form", () => {
    for (const form of OWNER_FORMS) expect(form.required.length, form.id).toBeGreaterThan(0);
  });

  it("lists every field it asks for on the form's own screen", () => {
    for (const form of OWNER_FORMS) {
      const listed = new Set((OWNER_FIELDS as Partial<Record<OwnerScreen, readonly string[]>>)[form.screen] ?? []);
      for (const field of fieldsOf(form)) {
        expect(listed, `${form.id}: "${field.label}" is not in OWNER_FIELDS["${form.screen}"]`).toContain(field.label);
      }
    }
  });

  it("does not list the same label twice on one form", () => {
    for (const form of OWNER_FORMS) {
      const labels = fieldsOf(form).map((f) => f.label);
      expect(new Set(labels).size, form.id).toBe(labels.length);
    }
  });

  it("keeps optional lists free of empty entries", () => {
    for (const form of OWNER_FORMS) {
      for (const field of fieldsOf(form)) {
        for (const alias of field.aliases ?? []) expect(alias.trim(), `${form.id}: "${field.label}"`).not.toBe("");
        for (const option of field.options ?? []) expect(option.trim(), `${form.id}: "${field.label}"`).not.toBe("");
      }
    }
  });

  it("names the web file it is read from, in the web app", () => {
    for (const form of OWNER_FORMS) {
      expect(form.source.file, form.id).toMatch(/^apps\/web\/src\/\S+\.tsx$/);
      expect(form.source.start, form.id).toMatch(/\S/);
    }
  });

  it("only lists forms a card can send the owner to from the registry, never a made-up one", () => {
    expect(OWNER_FORMS).toHaveLength(3);
  });
});

describe("OWNER_FORMS: deploy target", () => {
  const form = byId("deployTarget");

  it("needs a name, a kind and an address", () => {
    expect(form.required.map((f) => f.label)).toEqual(["Name", "Kind", "Address"]);
  });

  it("takes both what the screen shows and the short token form as a kind", () => {
    const kind = form.required.find((f) => f.label === "Kind")!;
    expect(kind.options).toEqual(expect.arrayContaining(["SSH host", "Docker endpoint", "Git remote", "ssh", "docker", "git"]));
  });

  it("asks for the tag fields only when the step moves a tag", () => {
    expect(form.groups).toHaveLength(1);
    const group = form.groups![0]!;
    expect(group.when).toBe(String.raw`\btag\b`);
    expect(group.fields.map((f) => f.label)).toEqual(["Tag name", "In the repo of"]);
  });

  it("fills its fields from the tokens a deploy-target record has", () => {
    expect(form.required.flatMap((f) => f.token ?? [])).toEqual(["name", "kind", "address"]);
    expect(form.groups![0]!.fields.flatMap((f) => f.token ?? [])).toEqual(["tagName"]);
  });
});

describe("OWNER_FORMS: secrets", () => {
  const form = byId("secret");

  it("asks for a variable name and a value, and marks the value secret", () => {
    expect(form.required.map((f) => f.label)).toEqual(["Variable name", "Value"]);
    expect(form.required.find((f) => f.label === "Value")!.secret).toBe(true);
    expect(form.required.find((f) => f.label === "Variable name")!.secret).toBeUndefined();
  });

  it("records why the form's own Add button is not a field the step must fill", () => {
    expect(form.notChecked).toHaveLength(1);
    expect(form.notChecked![0]!.label).toBe("Add");
    expect(form.notChecked![0]!.why).toMatch(/\S/);
  });
});

describe("OWNER_FORMS: tool server", () => {
  const form = byId("toolServer");

  it("needs a server name and a server URL", () => {
    expect(form.required.map((f) => f.label)).toEqual(["Server name", "Server URL"]);
  });

  it("has no extra groups or unchecked fields", () => {
    expect(form.groups).toBeUndefined();
    expect(form.notChecked).toBeUndefined();
  });
});
