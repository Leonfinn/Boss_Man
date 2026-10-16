# Boss Man artwork

Character art supplied by the owner on 16 Oct 2026. The originals are in `source/`. The files here are cut from them with a transparent background, so they sit on both the light and dark themes.

| File | What it shows | Where the UI uses it |
|---|---|---|
| `boss-logo.webp` | The full badge: "Boss Man, the AI agent manager" | First-run setup, the login screen, and About. Shown at 160 px or larger, because the tagline is unreadable when smaller. |
| `boss-mark-*.png` | Boss Man's head in a circle (32, 64, 180, 256 px) | Favicon (32), the sidebar header next to the "Boss Man" wordmark (64), Apple touch icon (180), and the PWA icon (256). |
| `boss-setup.webp` | At the whiteboard, planning a workflow | Onboarding: create your first company, connect a runner, add the setup-token. Also the empty state for a project with no board yet. |
| `boss-busy.webp` | At his desk with paperwork flying | Agents at work: the dashboard while runs are active, and the empty "nothing queued" state while agents are busy. |
| `boss-stuck.webp` | Scratching his head at a warning screen | Problems: runner offline, a stalled run, lost connection to the server, and error pages. |
| `boss-done.webp` | Thumbs up beside a "completion" chart | The decision queue when it's empty ("Nothing needs you"), and celebrating an engagement sign-off or a key result that reaches its target. |

## Rules
- Each illustration appears in only one place per screen, as an empty or status state, and never as decoration beside real data.
- Illustrations are at most 240 px tall on desktop and 160 px on a phone.
- Every image has alt text that says what the state means, for example "Runner offline". Don't describe the drawing.
- The mark is a crop of the badge. At 16 px it is only just readable, so browsers get the 32 px file.
