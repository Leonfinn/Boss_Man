// The three helpers behind R18 (DR-057, BOS-1285), named directly (BOS-2190): formsIn finds the registered forms a
// step mentions, fieldValues reads the value each of a form's fields gets, and formStepFindings is R18 over a card's
// steps. Today they are only reached through lintOwnerSteps in owner-form-steps.test.ts; this file pins them alone.
import { describe, expect, it } from "vitest";
import { OWNER_FORMS, type OwnerForm } from "@boss-man/shared";
import { fieldValues, formsIn, formStepFindings } from "../src/services/owner-form-steps.js";

const form = (id: string): OwnerForm => {
  const found = OWNER_FORMS.find((f) => f.id === id);
  if (!found) throw new Error(`OWNER_FORMS has no form ${id}`);
  return found;
};
const ids = (prose: string) => formsIn(prose).map((f) => f.id);

describe("formsIn: which registered forms a step names", () => {
  it("finds each of Boss Man's forms by its words", () => {
    expect(ids("Open Settings → Tools and deploys and add a deploy target.")).toEqual(["deployTarget"]);
    expect(ids("Open Settings → Tools and deploys and add a tool server.")).toEqual(["toolServer"]);
    expect(ids("Open Settings → Secrets and add a secret.")).toEqual(["secret"]);
  });

  it("returns nothing for a step that names no form", () => {
    expect(ids("Open Settings → Server and runner → Updates and press Build and update runners.")).toEqual([]);
    expect(ids("Tick the box that says After a successful deploy.")).toEqual([]);
  });

  it("finds both forms when one step names two, in registry order", () => {
    expect(ids("On Settings → Tools and deploys, add a tool server and a secret.")).toEqual(["toolServer", "secret"]);
  });

  it("matches whole words, not fragments of other words", () => {
    // "credentials" is not the registered word "credential", and a bare "server" is not a tool server.
    expect(ids("Open Settings → Server and runner and press Save.")).toEqual([]);
    expect(ids("Paste your credentials somewhere.")).toEqual([]);
  });

  it("does not treat a funding source as a registered form (it is left out on purpose)", () => {
    // OWNER_FORMS says why: the owner's plan and provider are their own account, so the step is complete as written.
    expect(ids("Open Settings → Funding → Add funding source.")).toEqual([]);
    expect(formStepFindings(["Open Settings → Funding → Add funding source."])).toEqual([]);
  });
});

describe("fieldValues: the value each field of a form gets", () => {
  it("reads every field of a deploy target from quoted values and a select choice", () => {
    const given = fieldValues(form("deployTarget"), "add a deploy target: Name `production`, Kind SSH host, Address `deploy@example.com`.");
    expect(given.size).toBe(3);
    expect(given.get("Name")).toBe("literal");
    expect(given.get("Kind")).toBe("literal");
    expect(given.get("Address")).toBe("literal");
  });

  it("reads a {{company.…}} token as a token, not a literal", () => {
    const given = fieldValues(
      form("deployTarget"),
      "Name `{{company.acme.deployTarget.name}}`, Kind `{{company.acme.deployTarget.kind}}`, Address `{{company.acme.deployTarget.address}}`.",
    );
    expect([...given.values()]).toEqual(["token", "token", "token"]);
  });

  it("leaves out a field the step does not mention", () => {
    const given = fieldValues(form("deployTarget"), "add a deploy target: Name `production`, Kind SSH host.");
    expect(given.has("Name")).toBe(true);
    expect(given.has("Kind")).toBe(true);
    expect(given.has("Address")).toBe(false);
  });

  it("accepts an arrow or a colon between a label and its value, even in the value", () => {
    const given = fieldValues(
      form("deployTarget"),
      "add a deploy target: Name → `prod→live`, Address: `ssh://deploy@example.com:2222/site.git`, Kind SSH host.",
    );
    expect(given.get("Name")).toBe("literal");
    expect(given.get("Address")).toBe("literal");
    expect(given.get("Kind")).toBe("literal");
  });

  it("reads a value written before the label", () => {
    expect(fieldValues(form("deployTarget"), "type `production` into Name.").get("Name")).toBe("literal");
  });

  it("counts a secret field once it is named, since the owner holds the value", () => {
    const given = fieldValues(form("secret"), "Variable name `GITHUB_TOKEN`, then paste your GitHub token into Value.");
    expect(given.get("Variable name")).toBe("literal");
    expect(given.get("Value")).toBe("literal");
  });
});

describe("formStepFindings: R18 over a card's steps", () => {
  it("passes a form step that gives every required value", () => {
    expect(
      formStepFindings(["Open Settings → Tools and deploys and add a deploy target: Name `production`, Kind SSH host, Address `deploy@example.com`."]),
    ).toEqual([]);
  });

  it("reports the form step that leaves a value out, naming only the missing field", () => {
    const findings = formStepFindings(["Open Settings → Tools and deploys and add a deploy target: Name `production`, Kind SSH host."]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("R18");
    expect(findings[0]!.step).toBe(1);
    expect(findings[0]!.problem).toContain('"Address"');
    expect(findings[0]!.problem).not.toContain('"Name"');
    expect(findings[0]!.problem).not.toContain('"Kind"');
  });

  it("reports the step that leaves a value out in a later step, at that step", () => {
    const findings = formStepFindings([
      "Open Settings → Server and runner → Updates and press Build and update runners.",
      "Add a secret on Settings → Secrets: Variable name `GITHUB_TOKEN`.",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.step).toBe(2);
    expect(findings[0]!.problem).toContain('"Value"');
  });

  it("passes a step that names no form at all", () => {
    expect(formStepFindings(["Open Settings → Server and runner → Updates and press Build and update runners."])).toEqual([]);
  });
});
