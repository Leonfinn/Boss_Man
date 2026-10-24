// `tsx src/canary-main.ts`: exits 0 when the image can run a Claude session (R52) and every
// add-on it holds works (docs/12).
import { addonList, canaryAddons } from "./addons.js";
import { runCanary } from "./canary.js";

const result = await runCanary();
const addons = await canaryAddons(addonList());
console.log(JSON.stringify({ ...result, addons }));
process.exit(result.ok && addons.ok ? 0 : 1);
