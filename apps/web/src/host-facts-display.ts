// "This host" panel wording (BOS-986): when a fact is missing or a check is failing, say in plain words what it is,
// what needs it and where it is entered or fixed, rather than the raw dotted name. The raw keys stay in the folded
// list; this is what the "Worth a look" line says, and the tests keep it in step with the facts the deployer reports.

export type HostFactsView = {
  hostName: string | null;
  reportedAt: string | null;
  ownerFacts: string[];
  /** BOS-990: whether the host's deployer script is the live version. Absent from an older server. */
  deployerScript?: { state: "current" | "behind" | "unknown" | "none"; since?: string };
  facts: Record<string, { value: string; source: "host" | "owner"; at: string; conflict?: { confirmed: string; reported: string } }>;
};

/** A fact only the owner gives, in the words the panel uses for it. */
export const OWNER_FACT_LABELS: Record<string, string> = {
  "network.publicAddress": "Address you reach Boss Man at from outside",
  "repo.deployKeyAdded": "Deploy key added to the code host (yes or no)",
};

/** What a fact only the owner gives is for, and where it is entered. */
const OWNER_FACT_HELP: Record<string, { what: string; needs: string; where: string }> = {
  "network.publicAddress": {
    what: "the internet address (or name) you use to reach Boss Man from outside your network",
    needs: "cards that put an address in a step, such as opening Boss Man from your phone",
    where: "enter it in Facts only you can give, below, and press Confirm",
  },
  "repo.deployKeyAdded": {
    what: "whether the deploy key is already added on the code host (GitHub), so Boss Man can read and update the code",
    needs: "cards that set the code host up; without it Boss Man can't tell whether that step is still needed",
    where: "answer yes or no in Facts only you can give, below, and press Confirm",
  },
};

// What counts as a failing check is one rule shared with the server's close gate (BOS-1586).
export { CHECK_OK, CHECK_TROUBLE, isFailingCheck } from "@boss-man/shared";

/**
 * BOS-2481: facts a host reports as empty when all is well, so an empty value is not "missing": the reason the
 * code-host read failed (empty when it worked) and the live blue/green colour (empty on a host without blue/green).
 */
export const NORMALLY_EMPTY_FACTS: ReadonlySet<string> = new Set(["repo.probeWhy", "compose.liveColour"]);

/** The service names of unhealthy or restarting containers, "; "-joined (BOS-2481; the host writes it). */
export const UNHEALTHY_CONTAINERS_KEY = "check.container_status.unhealthyNames";

/** The flattened value of the named stopped containers (the server writes it; see host-facts.ts). */
export const STOPPED_CONTAINERS_KEY = "check.container_status.stopped.names";

/**
 * Split the flattened stopped-container list back into entries (BOS-986). The server joins each entry with "; ",
 * which cannot occur inside a container name, so an entry that itself contains ", " (exit code, since when) stays
 * whole. Splitting on ", " printed fragments of a real report.
 */
export function stoppedContainerNames(value: string): string[] {
  return value
    .split("; ")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What a failing check is, and what to do about it. `names` is the reported list of stopped containers, when there
 * is one, so the line names them. `probeWhy` is the host's own one-line reason the code-host read failed.
 */
export function failingCheckText(key: string, d: HostFactsView, names: string[], probeWhy: string): { what: string; fix: string } {
  const v = d.facts[key]?.value?.trim() ?? "";
  if (key === "check.container_status.notRunning") {
    const total = d.facts["check.container_status.total"]?.value?.trim();
    const who = names.length ? `the containers ${names.join("; ")}` : `${v} container${v === "1" ? "" : "s"}`;
    return {
      what: `${who} ${v === "1" ? "is" : "are"} not running${total ? ` (of ${total} in the Boss Man stack)` : ""}`,
      fix: "a stopped or crashed container holds nothing back by itself, but the part of Boss Man it runs is down. The host's log says why it stopped; pressing Build and update runners, or the next update, starts the stack again. Someone with access to the host can look at that container's log.",
    };
  }
  if (key === "check.container_status.unhealthy") {
    const unh = (d.facts[UNHEALTHY_CONTAINERS_KEY]?.value ?? "").split("; ").map((s) => s.trim()).filter(Boolean);
    return {
      what: unh.length
        ? `${v} container${v === "1" ? " is" : "s are"} restarting or unhealthy: ${unh.join(", ")}`
        : `${v} container${v === "1" ? " is" : "s are"} restarting or unhealthy (this host's deployer is too old to name them)`,
      fix: "a container that keeps restarting is failing its own health check. The next update restarts the stack; if it comes back, its log on the host says why.",
    };
  }
  if (key === "repo.probe") {
    return {
      what: `Boss Man could not read the code host${probeWhy ? `: ${probeWhy}` : ""}`,
      fix: "deploys that already have the code still work, so this only stops the next check of what is waiting. It is usually the key or the address the host uses for the code host (a network or key change). Someone with access to the host can try the read there.",
    };
  }
  if (key === "check.restart_counts.max") {
    return { what: `a container has restarted ${v} time${v === "1" ? "" : "s"}`, fix: "build and update the runners from Settings → Server and runner → Updates; if it keeps restarting, its log on the host says why." };
  }
  if (key === "check.state_file_sizes.ageSeconds" || key === "check.state_file_sizes.stale") {
    return { what: "the host's own record is out of date", fix: "the host deployer runs every minute; a stale record means it hasn't run. Check that Boss Man's update service is running on the host." };
  }
  // BOS-2481: never an empty name. An empty value is a fact the host reported with nothing in it; otherwise the check
  // is named by its key and its value.
  if (!v) return { what: `The host reported "${key}" with no value`, fix: "the host's log says why it could not read it." };
  return { what: `The check "${key}" reports "${v}"`, fix: "this is a check the host runs about itself; its log on the host says more." };
}

/** The line the "Worth a look" block adds for a missing fact or a failing check. */
export function problemText(key: string, d: HostFactsView, names: string[], probeWhy: string): string {
  if (key in OWNER_FACT_HELP) {
    const h = OWNER_FACT_HELP[key]!;
    return `${OWNER_FACT_LABELS[key] ?? key} is missing: ${h.what}. Cards need it for ${h.needs}; ${h.where}.`;
  }
  const what = failingCheckText(key, d, names, probeWhy);
  return `${what.what}. ${what.fix}`;
}
