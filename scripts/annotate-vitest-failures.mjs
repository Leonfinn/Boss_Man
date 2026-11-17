// Turns a vitest JSON report into one GitHub error annotation that names the failing tests.
// The raw job log needs a GitHub login, but annotations are public through the check-runs API,
// so without this a red run said only "exit code 1" (BOS-1590, BOS-1705).
// Usage: node scripts/annotate-vitest-failures.mjs <report.json> <title>
import { readFileSync } from "node:fs";

export function failureSummary(report) {
  const bad = report.testResults.flatMap((f) =>
    f.assertionResults
      .filter((t) => t.status === "failed")
      .map((t) => `${f.name.split("/").pop()}: ${t.title}: ${(t.failureMessages[0] || "").split("\n")[0]}`),
  );
  const lost = report.testResults
    .filter((f) => f.status === "failed" && !f.assertionResults.length)
    .map((f) => `${f.name.split("/").pop()}: ${(f.message || "").split("\n")[0]}`);
  return [...bad, ...lost].slice(0, 12).join(" | ").replace(/[\r\n%]/g, " ").slice(0, 1500);
}

export function annotation(file, title) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return `::error title=${title}::no JSON report was written`;
  }
  let summary;
  try {
    summary = failureSummary(report);
  } catch {
    return `::error title=${title}::the JSON report had no test results`;
  }
  return `::error title=${title}::${summary || "no failed test in the report"}`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(annotation(process.argv[2], process.argv[3] || "tests failed"));
}
