// Title and end cards (plain text on Boss Man's dark background) and the order of the final cut.
export const cards = [
  { id: "00-title", seconds: 4, title: "Boss Man: a team of <em>AI agents</em> that builds your software", sub: "On your own server. You stay in charge." },
  { id: "99-end", seconds: 5, title: "Self-hosted. <em>Open source.</em>", sub: "github.com/Leonfinn/Boss_Man" },
];
// Scene ids from scenes.mjs and card ids from above, in playing order.
export const order = ["00-title", "01-board", "05-decisions-phone", "07-roadmap", "99-end"];
