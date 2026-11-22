// The merge line on 14 Nov 2026, 19:09 to 21:09 UTC (BOS-1511, BOS-1515): the merge_line_records rows of that window, with the
// ticket ids replaced by letters and the reviewer names left out. This is the jam the BOS-1515 alarms are tested against.
//
//   P1  check worker part 1 (BOS-1435): in the train from 19:09:51, held to land alone behind L at 20:14:29 (not recorded),
//       sent back at 21:08:49 with no reason given
//   L   BOS-1471, the ticket P1 clashed with: seated 20:14:29, landed 20:22:55
//   B, C, D  seated past P1 and landed 20:30:45, 20:38:00, 21:08:44
//   E, F waited behind P1 and were seated only once it left (21:08:52, 21:08:56)
//   X0  the last landing before the gap: 19:24:30; nothing landed again until W3 at 20:14:23 (50 minutes)
//   S, W1..W6  other tickets on the line in the window
//
// The rows don't record seats or passes (that is what BOS-1515 adds), so the replay in merge-stall.test.ts is a script built
// from them; NOV14_SCRIPT says which moments come from the rows and which are assumed.

export type Row = { who: string; at: string; event: string; hold?: string; passed?: boolean };

const day = "2026-11-14T";
const r = (who: string, time: string, event: string, extra: { hold?: string; passed?: boolean } = {}): Row => ({ who, at: `${day}${time}Z`, event, ...extra });

export const NOV14_ROWS: Row[] = [
  r("P1", "19:09:28.630", "approved"),
  r("P1", "19:09:29.592", "hold_started", { hold: "sign_off" }),
  r("P1", "19:09:43.189", "attempt"),
  r("P1", "19:09:51.036", "hold_ended", { hold: "sign_off" }),
  r("P1", "19:09:51.037", "hold_started", { hold: "train" }),
  r("W1", "19:18:47.347", "approved"),
  r("W1", "19:18:48.336", "hold_started", { hold: "sign_off" }),
  r("W1", "19:23:42.976", "hold_ended", { hold: "sign_off" }),
  r("W1", "19:23:42.977", "hold_started", { hold: "waits_on" }),
  r("X0", "19:24:19.549", "check_ended", { passed: true }),
  r("X0", "19:24:30.278", "merged"),
  r("S", "19:24:35.676", "hold_ended", { hold: "train" }),
  r("S", "19:24:35.677", "check_queued"),
  r("S", "19:29:28.655", "check_started"),
  r("S", "19:33:03.202", "check_ended", { passed: true }),
  r("B", "19:45:54.008", "approved"),
  r("B", "19:45:55.107", "attempt"),
  r("B", "19:46:01.875", "hold_started", { hold: "train" }),
  r("W2", "19:46:40.318", "approved"),
  r("W2", "19:46:41.321", "attempt"),
  r("W3", "19:46:43.123", "left"),
  r("W4", "19:46:44.246", "left"),
  r("W2", "19:46:51.705", "hold_started", { hold: "train" }),
  r("C", "19:53:18.563", "approved"),
  r("C", "19:53:19.801", "attempt"),
  r("C", "19:53:27.915", "hold_started", { hold: "train" }),
  r("W5", "19:58:09.805", "approved"),
  r("W5", "19:58:11.073", "attempt"),
  r("W5", "19:58:17.343", "hold_started", { hold: "train" }),
  r("W4", "20:13:25.628", "check_started"),
  r("W6", "20:13:43.994", "approved"),
  r("W6", "20:13:44.846", "hold_started", { hold: "sign_off" }),
  r("W4", "20:13:57.993", "check_ended", { passed: true }),
  r("W3", "20:13:58.000", "check_started"),
  r("W3", "20:14:19.169", "check_ended", { passed: true }),
  r("W3", "20:14:23.138", "merged"),
  r("W4", "20:14:28.371", "merged"),
  r("L", "20:14:29.298", "hold_ended", { hold: "train" }),
  r("L", "20:14:29.299", "check_queued"),
  r("S", "20:14:33.238", "merged"),
  r("B", "20:14:39.689", "hold_ended", { hold: "train" }),
  r("B", "20:14:39.690", "check_queued"),
  r("C", "20:14:42.027", "hold_ended", { hold: "train" }),
  r("C", "20:14:42.028", "check_queued"),
  r("L", "20:15:06.907", "check_started"),
  r("W6", "20:17:01.777", "attempt"),
  r("W6", "20:17:07.736", "hold_ended", { hold: "sign_off" }),
  r("W6", "20:17:07.737", "hold_started", { hold: "train" }),
  r("L", "20:22:44.183", "check_ended", { passed: true }),
  r("B", "20:22:44.188", "check_started"),
  r("L", "20:22:55.469", "merged"),
  r("D", "20:23:01.248", "hold_ended", { hold: "train" }),
  r("D", "20:23:01.249", "check_queued"),
  r("B", "20:30:39.107", "check_ended", { passed: true }),
  r("C", "20:30:39.114", "check_started"),
  r("B", "20:30:45.416", "merged"),
  r("C", "20:37:51.919", "check_ended", { passed: true }),
  r("C", "20:38:00.542", "merged"),
  r("D", "20:39:21.898", "check_started"),
  r("D", "21:08:35.878", "check_ended", { passed: true }),
  r("D", "21:08:44.841", "merged"),
  r("P1", "21:08:49.724", "hold_ended", { hold: "train" }),
  r("P1", "21:08:49.725", "left"),
  r("E", "21:08:52.386", "hold_ended", { hold: "train" }),
  r("E", "21:08:52.387", "check_queued"),
  r("F", "21:08:56.128", "hold_ended", { hold: "train" }),
  r("F", "21:08:56.129", "check_queued"),
];

export const at = (time: string) => Date.parse(`${day}${time}Z`);
const rowAt = (who: string, event: string) => {
  const found = NOV14_ROWS.find((x) => x.who === who && x.event === event);
  if (!found) throw new Error(`No ${event} row for ${who} in the 14 Nov fixture.`);
  return Date.parse(found.at);
};

/**
 * The replay of 20:14 to 21:09 for the empty-seat alarm. From the rows: every landing (L, B, C, D) at its merged time, P1
 * leaving at its left time, E and F seated only after P1 left, and the order of the places (each ticket's train hold start).
 * Assumed, because the rows don't say: P1 seated beside L at 20:14:29 and put back to land alone a moment later (BOS-1511's
 * finding, which the swallowed hold row hid); a third seat from 20:14:36 (a check worker coming up: BOS-1435 grows seats
 * with ready workers), so B and C are seated past P1 as the rows show; D joining (and taking its place) just before L landed;
 * and E and F in the background tier, so D is seated ahead of them. That makes B, C and D the three tickets that passed P1.
 * When D lands the train is empty, so P1 is seated as the head and E and F beside it; P1 then goes back (its clash with main).
 */
export const NOV14_SCRIPT = {
  seats: (t: number) => (t < at("20:14:36") ? 2 : 3),
  start: at("20:14:00"),
  end: at("21:10:00"),
  /** P1 is put back to land alone at this moment (its stacked prepare on L didn't merge). */
  heldAloneAt: at("20:14:35"),
  joins: [
    { who: "L", at: at("20:14:00"), priority: 1, place: at("18:58:34") },
    { who: "P1", at: at("20:14:00"), priority: 1, place: at("19:09:51") },
    { who: "B", at: at("20:14:00"), priority: 1, place: at("19:46:01") },
    { who: "C", at: at("20:14:00"), priority: 1, place: at("19:53:27") },
    { who: "E", at: at("20:14:00"), priority: 2, place: at("18:49:00") },
    { who: "F", at: at("20:14:00"), priority: 2, place: at("18:49:07") },
    { who: "D", at: at("20:22:50"), priority: 1, place: at("20:22:50") },
  ],
  lands: [
    { who: "L", at: rowAt("L", "merged") },
    { who: "B", at: rowAt("B", "merged") },
    { who: "C", at: rowAt("C", "merged") },
    { who: "D", at: rowAt("D", "merged") },
  ],
  /** When P1 really went back (no reason recorded), and when a trial on main would have sent it (L landed: B2). */
  p1Left: rowAt("P1", "left"),
  p1SentBackByTrial: rowAt("L", "merged"),
  /** The seats that freed and stayed empty. */
  emptySeats: [rowAt("B", "merged"), rowAt("C", "merged")],
};

/** The no-landing gap: X0 landed 19:24:30, then nothing until W3 at 20:14:23, while S was seated and P1, B, C, W2, W5 waited. */
export const NOV14_GAP = {
  lastLanding: rowAt("X0", "merged"),
  nextLanding: rowAt("W3", "merged"),
};
