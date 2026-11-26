// What each outside service's answer means, in one place (BOS-2740, R1). We reported Google's sitemap as "pending,
// 0 errors" while the owner's screen said "Couldn't fetch": both meant Google had never read the file. The API has no
// field for a fetch failure, and "0 errors" only counts problems inside a file that has been read. The G3 receipt
// gate (host-fact-gate.ts, BOS-2598) reads this file; the wiki page is generated from it (`renderReadingsMarkdown`).

export interface ServiceReading {
  /** Stable key. */
  id: string;
  service: string;
  /** The API field(s) an agent reads. */
  apiField: string;
  /** What the owner's screen shows for each API value: [API value, screen text]. */
  screen: ReadonlyArray<readonly [string, string]>;
  /** The reading that counts as done. */
  done: string;
  /** What the API cannot tell us, with the tie-breaker for each. */
  blindSpots: ReadonlyArray<{ blind: string; tieBreaker: string }>;
  /** The normal turnaround before a re-check makes sense. */
  turnaround: string;
  /** "confirmed against the owner's screen on <date>, image <id>" or "not yet confirmed". */
  confirmed: string;
}

export const SERVICE_READINGS: readonly ServiceReading[] = [
  {
    id: "search-console-sitemap",
    service: "Google Search Console: sitemap",
    apiField: "sitemaps.get: lastDownloaded, isPending, errors, warnings, contents[].submitted",
    screen: [
      ["isPending true, lastDownloaded unset", "Couldn't fetch, or Pending: Google has not read the file"],
      ["isPending false, lastDownloaded set, errors 0", "Success, with a Last read date and a discovered-pages count"],
      ["errors above 0", "Has errors: Google read the file and found problems inside it"],
    ],
    done: "lastDownloaded set, isPending false, errors 0, and submitted above 0",
    blindSpots: [
      { blind: "No field for a fetch failure: \"Couldn't fetch\" shows as isPending true with errors 0.", tieBreaker: "Read lastDownloaded: unset means never read, whatever errors says." },
      { blind: "errors counts problems inside a file that was read, so 0 means nothing before the first read.", tieBreaker: "Quote the read date next to any \"0 errors\"." },
      { blind: "submitted counts URLs in the file, not URLs Google indexed.", tieBreaker: "Use URL Inspection for a page's index state." },
    ],
    turnaround: "up to 48 hours for a first read",
    confirmed: "not yet confirmed (the owner's screen said \"Couldn't fetch\" on 26 Nov 2026; no image id recorded)",
  },
  {
    id: "search-console-url-inspection",
    service: "Google Search Console: URL Inspection",
    apiField: "urlInspection.index.inspect: indexStatusResult.verdict, coverageState, lastCrawlTime",
    screen: [
      ["verdict PASS, lastCrawlTime set", "URL is on Google"],
      ["verdict NEUTRAL, coverageState \"Discovered - currently not indexed\" or \"Crawled - currently not indexed\"", "URL is not on Google"],
      ["verdict FAIL", "URL is not on Google, with the reason shown"],
    ],
    done: "verdict PASS and lastCrawlTime set (a date after the change went live)",
    blindSpots: [
      { blind: "The result can be an older crawl than the change.", tieBreaker: "Compare lastCrawlTime with the go-live time." },
      { blind: "It inspects the indexed copy, not the live page.", tieBreaker: "Do not use it to prove the live page changed; use a browser screenshot." },
    ],
    turnaround: "days; a new URL can take a week or more",
    confirmed: "not yet confirmed",
  },
  {
    id: "bing-sitemap",
    service: "Bing Webmaster Tools: sitemap",
    apiField: "GetFeeds: Status, LastCrawled, UrlCount",
    screen: [
      ["Status Pending, LastCrawled unset", "Pending: Bing has not read the file"],
      ["Status Success, LastCrawled set", "Success with a last crawled date"],
      ["Status Error", "Error with the reason shown"],
    ],
    done: "Status Success, LastCrawled set, UrlCount above 0",
    blindSpots: [
      { blind: "A submit reply only proves Bing got the request.", tieBreaker: "Wait for LastCrawled; quote it." },
      { blind: "UrlCount can lag the crawl.", tieBreaker: "Re-read after the turnaround before calling it zero." },
    ],
    turnaround: "up to 72 hours",
    confirmed: "not yet confirmed",
  },
  {
    id: "github-actions-run",
    service: "GitHub Actions: workflow run",
    apiField: "actions/runs: status, conclusion, head_sha",
    screen: [
      ["status queued or in_progress", "Yellow dot: running or waiting"],
      ["status completed, conclusion success", "Green tick"],
      ["status completed, conclusion failure, cancelled or skipped", "Red cross, grey stop or grey skip"],
    ],
    done: "status completed, conclusion success, on the head_sha that was merged",
    blindSpots: [
      { blind: "A green run may be for an older commit.", tieBreaker: "Compare head_sha with the merged commit." },
      { blind: "skipped and cancelled are not success.", tieBreaker: "Only conclusion success counts." },
    ],
    turnaround: "5 to 20 minutes; longer when runners are busy",
    confirmed: "not yet confirmed",
  },
  {
    id: "ntfy-delivery",
    service: "ntfy: push delivery",
    apiField: "publish reply: id, time, event; poll of the topic for the message id",
    screen: [
      ["publish reply with an id", "Nothing yet: the server took the message"],
      ["message found when polling the topic", "The message appears in the topic's list"],
      ["phone shows the push", "The owner's phone notification"],
    ],
    done: "the message is read back from the topic by its id, or the owner confirms the phone showed it",
    blindSpots: [
      { blind: "A publish reply says the server took it, not that a phone got it.", tieBreaker: "Ask the owner, or read the topic back." },
      { blind: "A phone can be asleep or offline.", tieBreaker: "Allow a few minutes before calling it lost." },
    ],
    turnaround: "seconds for the topic; up to a few minutes for a phone",
    confirmed: "not yet confirmed",
  },
];

/** A read date: an ISO date, or a day and month name ("26 Nov", "Nov 26"). A field name like lastDownloaded is not one. */
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const READ_DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\.?\\s+\\d{1,2}\\b`, "i");
const ZERO_ERRORS = /\b(?:0|zero|no)\s+errors?\b/i;

/**
 * BOS-2740: "0 errors" or "no errors" with no read date. The count only covers a file the service has read, so without
 * a date it can mean "never read". True when the text claims zero errors and quotes no date.
 */
export function zeroErrorsWithoutReadDate(text: string): boolean {
  return ZERO_ERRORS.test(text) && !READ_DATE.test(text);
}

/** The wiki page, generated from the table: a markdown table per service. */
export function renderReadingsMarkdown(rows: readonly ServiceReading[] = SERVICE_READINGS): string {
  const cell = (s: string): string => s.replace(/\|/g, "\\|");
  const out: string[] = [
    "# Outside-service readings",
    "",
    "Generated from `packages/shared/src/outside-service-readings.ts`: change the table there, not this page. A service's receipt (\"pending\", \"submitted\", 204) is not a reading. \"0 errors\" counts only a file the service has read, so quote the read date with it.",
  ];
  for (const r of rows) {
    out.push("", `## ${r.service}`, "", `- API field: ${r.apiField}`, `- Done: ${r.done}`, `- Normal turnaround: ${r.turnaround}`, `- Owner's screen: ${r.confirmed}`, "", "| API value | Owner's screen shows |", "| --- | --- |");
    for (const [api, screen] of r.screen) out.push(`| ${cell(api)} | ${cell(screen)} |`);
    out.push("", "| Blind spot | Tie-breaker |", "| --- | --- |");
    for (const b of r.blindSpots) out.push(`| ${cell(b.blind)} | ${cell(b.tieBreaker)} |`);
  }
  return `${out.join("\n")}\n`;
}
