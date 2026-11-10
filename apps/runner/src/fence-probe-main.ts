// `tsx src/fence-probe-main.ts`: prints the fence self-test as JSON and exits 0 only when the Landlock fence
// really works here (a fenced write inside its folder succeeds, one outside is refused). CI runs it inside the
// runner image on every CPU architecture (scripts/image-tests.sh).
import { sandboxSelfTest } from "./fence.js";

const report = sandboxSelfTest();
console.log(JSON.stringify(report));
process.exit(report.landlockAbi > 0 && report.level !== "unavailable" && report.probe === true ? 0 : 1);
