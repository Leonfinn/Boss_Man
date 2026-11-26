// The one list of keyboard shortcuts (BOS-2687). The key handler, the "?" dialog and (later) the menu
// tooltips all read from here, so a key that works is a key that is listed. To add a shortcut, add a row.

/** How long after "g" the second letter still counts. */
export const G_WINDOW_MS = 1500;

/** The key that starts a jump ("g" then a letter). */
export const JUMP_PREFIX = "g";
/** The key that opens the list. */
export const HELP_KEY = "?";

/** "g" + letter → the route the sidebar's link for that screen opens. "b" is worked out at press time. */
export const JUMPS: Array<{ key: string; label: string; to: string }> = [
  { key: "d", label: "Dashboard", to: "dashboard" },
  { key: "b", label: "Board", to: "board" },
  { key: "c", label: "Chat", to: "chat" },
  { key: "i", label: "Decisions", to: "decisions" },
  { key: "n", label: "Notifications", to: "notifications" },
  { key: "r", label: "Runs", to: "runs" },
  { key: "w", label: "Wiki", to: "wiki" },
  { key: "f", label: "Features", to: "features" },
  { key: "s", label: "Settings", to: "settings" },
];

/** What a card key does on a screen that marks its cards with `data-shortcut-card`. */
export type CardAction = "next" | "prev" | "open";

export type ScreenRow = { keys: string[]; action: CardAction; what: string };

export type ScreenKeys = {
  /** Short name used in the list's heading ("On the Board" / "On Runs"). */
  name: string;
  title: string;
  /** The page file under src/pages that marks its cards. A guard test checks every such file has a row here. */
  pageFile: string;
  /** Matches location.hash on the screen. */
  match: RegExp;
  rows: ScreenRow[];
};

function cardRows(next: string, prev: string, open: string): ScreenRow[] {
  return [
    { keys: ["j"], action: "next", what: next },
    { keys: ["k"], action: "prev", what: prev },
    { keys: ["Enter"], action: "open", what: open },
  ];
}

export const SCREENS: ScreenKeys[] = [
  {
    name: "Board",
    title: "On the Board",
    pageFile: "Board.tsx",
    match: /^#\/board(\/|$)/,
    rows: cardRows("Next card (down the lane, then the next lane)", "Previous card", "Open the card's task"),
  },
  {
    name: "Decisions",
    title: "On Decisions",
    pageFile: "Decisions.tsx",
    match: /^#\/decisions(\/|$)/,
    rows: cardRows("Next card", "Previous card", "Go to the card's answer buttons"),
  },
  {
    name: "Runs",
    title: "On Runs",
    pageFile: "Runs.tsx",
    match: /^#\/runs\/?(\?|$)/,
    rows: cardRows("Next row", "Previous row", "Open the run's page"),
  },
  {
    name: "Features",
    title: "On Features",
    pageFile: "Features.tsx",
    match: /^#\/features(\/[^/?]+)?\/?(\?|$)/,
    rows: cardRows("Next row", "Previous row", "Open the feature's page"),
  },
];

/** The current screen's own keys for the "?" list, or null on a screen without any. */
export function screenKeys(hash: string): { title: string; rows: Array<{ keys: string[]; what: string }> } | null {
  const s = SCREENS.find((x) => x.match.test(hash));
  return s ? { title: s.title, rows: s.rows.map(({ keys, what }) => ({ keys, what })) } : null;
}

/** The card action a pressed key stands for, from the rows above (j, k, Enter), or null. */
export function cardActionFor(key: string): CardAction | null {
  for (const s of SCREENS) for (const r of s.rows) if (r.keys.includes(key)) return r.action;
  return null;
}
