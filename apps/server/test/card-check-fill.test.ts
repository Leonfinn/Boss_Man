// BOS-2222: card text the owner reads keeps no raw {{…}} tokens. fillCardText fills the host facts Boss Man has and
// refuses a token it can't fill, naming the field. Made-up hosts and paths only.
import { describe, expect, it } from "vitest";
import { fillCardText } from "../src/services/card-check.js";

const VALUES = { "paths.src": "/srv/example/src", "env.file": "/srv/example/.env" };
const TRIED = "Checked the host from the runner; agents have no access to the owner's machine.";

describe("fillCardText fills host tokens in the owner-visible text", () => {
  it("fills every placeholder in the question, the options and triedFirst", () => {
    const r = fillCardText(
      {
        question: "Edit {{host.env.file}} now?",
        options: ["Yes, {{host.env.file}} is ready", "No, keep {{host.paths.src}} as it is"],
        triedFirst: `${TRIED} Looked in {{host.paths.src}}.`,
      },
      VALUES,
    );
    expect(r).toEqual({
      question: "Edit /srv/example/.env now?",
      options: ["Yes, /srv/example/.env is ready", "No, keep /srv/example/src as it is"],
      triedFirst: `${TRIED} Looked in /srv/example/src.`,
    });
  });

  it("leaves text with no placeholder unchanged, and keeps an absent field absent", () => {
    expect(fillCardText({ triedFirst: TRIED }, VALUES)).toEqual({ triedFirst: TRIED });
    expect(fillCardText({ question: "Close it?", options: ["Yes", "No"], triedFirst: TRIED }, VALUES)).toEqual({ question: "Close it?", options: ["Yes", "No"], triedFirst: TRIED });
  });

  it("refuses a placeholder the host facts don't have, naming the field", () => {
    const r = fillCardText({ triedFirst: TRIED, question: "Edit {{host.paths.nope}} now?" }, VALUES);
    expect(r).toHaveProperty("error");
    expect("error" in r && r.error).toMatch(/^The question uses host facts Boss Man doesn't have: \{\{host\.paths\.nope\}\}/);
  });

  it("refuses each unfilled field: an option and triedFirst", () => {
    const option = fillCardText({ question: "Ready?", options: ["Yes", "Use {{host.paths.src}}"], triedFirst: TRIED });
    expect("error" in option && option.error).toMatch(/^Option 2 has \{\{host\.paths\.src\}\}/);
    const tried = fillCardText({ triedFirst: `${TRIED} See {{host.env.file}}.` });
    expect("error" in tried && tried.error).toMatch(/^triedFirst has \{\{host\.env\.file\}\}/);
  });
});
