# Boss Man artwork

Character art supplied by the owner on 16 Oct 2026. The originals are in `source/`: 1024 px JPEGs on white. The files here are cut out from them with a transparent background and soft edges, so they sit on both the light and dark themes. To rebuild them after the originals change, see "Rebuilding" below.

| File | What it shows | Where the UI uses it |
|---|---|---|
| `boss-logo.webp` | The full badge: "Boss Man, the AI agent manager" | First-run setup, the login screen, and About. Shown at 160 px or larger, because the tagline is unreadable when smaller. |
| `boss-mark-*.png`, `favicon.ico` | Boss Man's head (32, 64, 180, 256, 512 px; the ico holds 16 and 32) | Favicon (`favicon.ico` and 32), the sidebar header next to the "Boss Man" wordmark (64), Apple touch icon (180), and PWA icons (256, 512). |
| `boss-setup.webp` | At the whiteboard, planning a workflow | Onboarding: create your first company, connect a runner, add the setup-token. Also the empty state for a project with no board yet. |
| `boss-busy.webp` | At his desk with paperwork flying | Agents at work: the dashboard while runs are active, and the empty "nothing queued" state while agents are busy. |
| `boss-stuck.webp` | Scratching his head at a warning screen | Problems: runner offline, a stalled run, lost connection to the server, and error pages. |
| `boss-done.webp` | Thumbs up beside a "completion" chart | The decision queue when it's empty ("Nothing needs you"), and celebrating an engagement sign-off or a key result that reaches its target. |
| `agents/*.svg` | Boss Man's team: one head-and-shoulders portrait per role template (`engineer.svg`, `qa.svg`, …) and `wiki.svg` for the Wiki Maintainer | Each agent's avatar (Kanban cards, Chat, Dashboard, Agents), unless the owner uploads a picture for that agent. The CEO uses `boss-mark-64.png`. Drawn by `agents/generate.mjs` (run it with node after editing); agents without a template show their initials. |

## Rules
- Each illustration appears in only one place per screen, as an empty or status state, and never as decoration beside real data.
- Illustrations are at most 240 px tall on desktop and 160 px on a phone.
- Every image has alt text that says what the state means, for example "Runner offline". Don't describe the drawing.
- Illustrations are at most 640 px on their long side, which is enough for 240 px at 2× pixel density.

## Rebuilding
The cut-outs come from `source/BossMan_*.jpg`:
1. Near-white pixels connected to the image edge are made transparent. For the head, this starts from the top and sides only, so the collar at the bottom edge stays.
2. A 2-pixel band along that edge gets colour-to-alpha against white, so outlines fade out without a white halo.
3. Illustrations are scaled to 640 px on their long side and saved as WebP. The logo stays at 1024 px.

Replacements with transparent backgrounds can skip steps 1 and 2.
