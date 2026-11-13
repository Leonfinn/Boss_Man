/**
 * The owner forms an owner card may send the owner to, and the fields each one needs (DR-057, BOS-1285). The card
 * lint (rule R18, apps/server/src/services/owner-form-steps.ts) refuses a step that tells the owner to add, fill in
 * or edit one of these forms without a value for every required field: four cards in a row had the right shape and
 * no values ("add the target if it isn't there yet, or press Edit on it", with no name, kind or address).
 *
 * `apps/server/test/owner-forms.test.ts` reads each form in apps/web/src (`source`) and fails when an input or select
 * marked `required` there has a label this list lacks, or a field here isn't in OWNER_FIELDS for its screen. Adding a
 * required field to a form therefore means adding it here too.
 *
 * Only forms cards point at are listed. A step that names a "Settings → … form" this list doesn't know is refused,
 * so an unlisted form can't slip past quietly.
 */
import type { OwnerScreen } from "./owner-controls.js";

export type OwnerFormField = {
  /** The label as the screen shows it (OWNER_FIELDS). */
  label: string;
  /** Other words a step may use for the field ("endpoint" for Address). */
  aliases?: readonly string[];
  /** A select: these choices count as a value even unquoted ("Kind SSH host"). */
  options?: readonly string[];
  /** A secret the owner holds (a token): describing it ("paste your GitHub token") is enough; it is never written on a card. */
  secret?: boolean;
  /** The `{{company.<slug>.deployTarget.<token>}}` field that fills it from the server's record (DR-057 point 3). */
  token?: string;
};

export type OwnerForm = {
  id: string;
  screen: OwnerScreen;
  /** The button path to the form, as a step writes it. */
  path: string;
  /** What a refusal calls it. */
  name: string;
  /** Words in a step that mean this form (matched whole, any case). */
  names: readonly string[];
  /** Every field a new entry needs. Editing an entry needs the first (which entry) plus any group the step touches. */
  required: readonly OwnerFormField[];
  /** Fields that only show once a step uses `when` (a tickbox that opens more fields). */
  groups?: ReadonlyArray<{ when: string; fields: readonly OwnerFormField[] }>;
  /** A required field in the web form that R18 deliberately doesn't ask for, with the reason (the registry test reads it). */
  notChecked?: ReadonlyArray<{ label: string; why: string }>;
  /** The web file the form is in and a string that starts it there, for the registry test. */
  source: { file: string; start: string };
};

export const OWNER_FORMS: readonly OwnerForm[] = [
  {
    id: "deployTarget",
    screen: "Tools and deploys",
    path: "Settings → Tools and deploys",
    name: "Deploy targets → Add a deploy target",
    // "move tag" is the deploy tag's tickbox, so a step that only ticks it is still on this form.
    names: ["deploy target", "deploy targets", "add target", "add a deploy target", "move tag"],
    required: [
      { label: "Name", token: "name" },
      { label: "Kind", options: ["SSH host", "Docker endpoint", "Git remote", "ssh", "docker", "git"], token: "kind" },
      { label: "Address", aliases: ["endpoint"], token: "address" },
    ],
    groups: [{ when: String.raw`\btag\b`, fields: [{ label: "Tag name", token: "tagName" }, { label: "In the repo of" }] }],
    source: { file: "apps/web/src/pages/settings/Tools.tsx", start: 'aria-labelledby="deploy-target-form-h"' },
  },
  {
    id: "toolServer",
    screen: "Tools and deploys",
    path: "Settings → Tools and deploys",
    name: "Tool servers → Add tool server",
    names: ["tool server", "tool servers", "add tool server", "mcp server"],
    required: [{ label: "Server name" }, { label: "Server URL" }],
    source: { file: "apps/web/src/pages/settings/Tools.tsx", start: '<label htmlFor="mcp-name">' },
  },
  {
    id: "secret",
    screen: "Secrets",
    path: "Settings → Secrets",
    name: "Secrets → Add",
    names: ["secret", "credential", "add a secret", "add a credential"],
    required: [{ label: "Variable name" }, { label: "Value", secret: true }],
    notChecked: [{ label: "Add", why: "the kind picker only pre-fills Variable name, which the step must give anyway; and \"add\" is the step's own verb" }],
    source: { file: "apps/web/src/pages/settings/Credentials.tsx", start: '<label htmlFor="cred-kind">' },
  },
  // Not listed: Funding → Add funding source. Its values (which plan, which provider, its name) are the owner's own
  // account, which no agent or record knows, so "Settings → Funding → Add funding source" is a complete step.
];
