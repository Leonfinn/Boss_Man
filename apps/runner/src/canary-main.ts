// `tsx src/canary-main.ts`: exits 0 when the image can run a Claude session (R52).
import { runCanary } from "./canary.js";

const result = await runCanary();
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
