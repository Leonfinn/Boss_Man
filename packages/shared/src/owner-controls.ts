/**
 * The controls the owner can press in the web app, by screen (BOS-421, DR-009 L6). The owner-card lint refuses a
 * card that tells the owner to press something not on this list (`lintOwnerSteps`, rule R7), so a card can't send
 * them to a button that doesn't exist (3 Nov 15:10, "Overrule and merge").
 *
 * `apps/server/test/owner-control-list.test.ts` reads every <button> in apps/web/src and fails when a label is missing
 * here or an entry here no longer has a button, so a change to a button's text must change this list too.
 *
 * Since BOS-442 each Settings tab is a screen of its own (a funding source is added on Access and funding, not on
 * Funding), the form fields are listed too (OWNER_FIELDS), and OWNER_MENU and OWNER_TABS give the menus a step's
 * path ("Settings → Secrets") is checked against (rules R8 and R13, apps/server/src/services/owner-screens.ts).
 *
 * A label ending in " …" has a value inside it ("Open …" is "Open Acme's Kanban"): anything may follow the words
 * before the "…". A card's own options are buttons too; the lint adds them, so they are not listed here.
 * The list lives in shared rather than the web app because the server lints cards and must not import web code.
 */
export const OWNER_CONTROLS = {
  // On every screen: the sidebar menu, its buttons, the Save button forms share, file attach, and the
  // browser's own confirm dialog (window.confirm) that many deletes use.
  "Any screen": [
    "Dashboard", "Decisions", "Notifications", "Chat", "Projects", "Roadmap", "Plan", "Wiki", "Features", "Feedback",
    "Agents", "Skills", "Runs", "Merge queue", "Scrum Master log", "Workflow report", "Engagements", "Settings",
    "Switch company", "Create", "Creating", "New company", "Close menu", "Menu …", "Log out",
    "Save", "Saving", "Saved", "Attach file", "Attaching", "Remove", "Try again", "OK", "Cancel",
    // The error line a page shows when its first load fails (Features, Chat).
    "Retry",
    // The owner's message box (Ticket, Board, Chat, Decisions and Run show it).
    "Send as a .txt file", "Sending",
    // A picture opened from Markdown text.
    "Actual size", "Fit to window",
    // Under a paged list, Skill proposals and Engagements (BOS-2165): the next page of older entries.
    "Show older", "Loading",
    // The banner shown when Boss Man was updated after the page was opened (BOS-550).
    "Reload",
    // The banner shown while Settings → Server and runner → Stop all work is on (BOS-836).
    "Resume",
    // The Dashboard's "Company paused" notice has the same button, busy label "Resuming".
    "Resuming",
    // Every page intro's fold (P7, BOS-1278): Agents, Server and runner, Notifications and Features show it.
    "More about this",
  ],
  "Log in": ["Create owner account", "Log in"],
  Setup: [
    "Create the company", "Add the project", "Check the token against …", "Add the task to …", "Continue", "Dismiss", "Saving",
    "Back", "Next", "Skip for now", "Finish", "I know what I'm doing, let me get on with it",
    // The Claude and runner steps (BOS-1495), then the credentials, funding and project panels Setup shares with Settings and Projects.
    "Save the token", "Start the runner",
    "Save", "Check with Claude", "Check", "Remove", "Edit", "Delete", "Add funding source", "Cancel", "Re-detect",
  ],
  Decisions: [
    "Show more", "Show less", "Show all …", "Show the whole", "Save and approve", "Cancel", "Edit these values before approving", "All companies",
    // The project filter chips (BOS-1744); project names are data, these two are fixed.
    "All projects", "Company-wide",
    "Reassign to the one I picked", "Let the CEO decide", "Back to the options", "Write my own answer", "Use suggestion",
    "Send my answer", "Ask the CEO for advice",
    // An update card's ticket list (BOS-809): "+N more" opens it, "Show fewer" folds it back.
    "Show fewer",
    // Under each command in a step (the label is set in code, so the test can't read it).
    "Copy",
  ],
  Notifications: ["Turn on browser notifications", "Mark read", "Send a test to my phone", "Copy address", "Unread", "Read", "Mark these read", "Mark all read", "Clear filters", "Try again", "Show less", "Show all …", "Show the whole", "Create phone login", "Set up ntfy for me", "Reset password", "Copy password", "I've saved it", "Waiting for the host"],
  Chat: ["Ask the CEO", "Send", "Show more", "Show less", "Running now", "Load older messages", "Loading"],
  // A project's page (Projects → a project). Its tabs along the top, then the Kanban tab's buttons.
  Board: [
    "Kanban", "Budget", "Config",
    "Save", "Cancel", "New feature", "New task", "Add feature", "Add and start", "Add to backlog",
    "Let the CEO question me first", "Add task", "All", "Features", "Tasks", "Show fewer", "Show",
    "Show all done tasks", "Run now", "Discard draft", "Add limit",
    // The filters behind one Filter button (BOS-1194): its button and count, the chips' and panel's ways to clear,
    // and the way out of a column emptied by filters. "Working now" is a switch with only a label there now, not a button.
    "Filter", "Clear all", "Clear filters", "Clear search",
  ],
  Ticket: [
    "Save criteria", "Done", "Add a line", "Edit criteria", "Send it back", "Cancel", "Approve",
    "Release hold", "Cancel hold and review again", "Removing",
    "Approve and open a pull request", "Approve and merge", "Request changes", "Run now", "Description", "Edit",
    "Save description", "Refresh all changes", "All changes", "Refresh the last turn", "The last turn", "Try merging now",
    "Show", "Hide", "Block", "Save", "Check now", "Clear", "Schedule a check",
    "Make Priority 1", "Priority 1 is on", "Edit steps and lines", "Save steps", "Discard draft",
    // A text field someone else changed was refused: the owner's draft stays and this brings in the latest (BOS-905).
    "Reload the latest",
    // A Details row's own request failed: fetch it again (BOS-1195).
    "Try again",
    // The ticket's conversation, links, outputs and reviews.
    "Send", "Interrupt and send", "Stop", "Add", "Remove", "Reviews",
    // Past the newest 500 messages, the conversation's older pages (BOS-2168).
    "Load older messages", "Loading older messages",
    // The Scrum Master's log of this ticket.
    "Undo", "Undoing", "Scrum Master", "Show all …",
  ],
  // A project's Config tab (repo and merge-check settings, brief, archive), and the Projects page, which shows
  // the same settings for every project. The merge-check setting ("Before merging, Boss Man will…") is here,
  // not under Settings.
  Config: ["Re-detect", "Refresh brief", "Write brief", "Archive", "Unarchive"],
  // Each project is a collapsed row; "Edit settings" opens its form and "Hide settings" folds it away (BOS-1876).
  Projects: ["Open …", "Unarchive", "Saving", "Re-detect", "Check now", "Edit settings", "Hide settings"],
  Run: ["Send after this turn", "Interrupt and send", "Stop run"],
  // The Runs page's emergency stop: every run going now, in every company (BOS-837).
  Runs: ["End all running runs", "Ending", "Loading", "Show more", "Retry"],
  // The Merge queue page's two views (BOS-1174).
  // Below three recently finished checks, "Show N more" opens the rest (BOS-1239).
  "Merge queue": ["Merges", "Quick checks", "Show …", "Move to front"],
  Roadmap: ["Save", "Delete", "Add a milestone", "Add", "Cancel", "Mark done", "Remove", "Reopen", "No date …", "Add objective", "Milestones"],
  Plan: [
    "Refresh",
    // "What's holding work up" (BOS-745): its heading folds the section away and opens it again (the label carries
    // the count), and below a long list "Show all …" (with the count) and "Show fewer" open and shorten it.
    "What's holding work up …", "Show all …", "Show fewer",
    // BOS-1306: the labelled Hide / Show button at the right end of that heading.
    "Hide", "Show",
  ],
  Wiki: [
    "Show older versions", "Compare", "Close compare", "Show", "Restore this version",
    "Write", "Preview", "Cancel", "Edit", "New page here", "History …", "Delete", "Put this version back",
    "Back to the current one", "Re-embed all", "Test", "Hide pages", "Show pages", "New page", "Discard draft",
  ],
  Features: [
    "Remove", "Add", "Add feature", "Criteria and areas", "Create task", "Save", "Cancel", "Edit title and description",
    "Save summary", "Delete feature", "Discard draft", "Expand all", "Collapse all", "Save reason",
    "Tasks", "Less", "How the portal works", "Adding",
  ],
  Feedback: [
    "Add feedback", "Add to the inbox", "Cancel", "Use the whole note", "Create …", "Creating", "Back to the list", "Unlink",
    "Link to …", "Done: mark processed", "Back to unprocessed", "Archive", "Delete", "Copy", "New link", "Remove",
    "Feedback portal", "Search", "Anonymous …", "Save times",
  ],
  "Feedback portal": ["Edit your comment", "Tell us why", "Remove my vote", "Send", "Cancel", "Send idea", "Send my vote"],
  Agents: [
    "Refresh models", "Asking the runner", "Choose from the list", "Hire …", "Use the default", "Replace with the current …",
    "Fill in from the …", "Rehire", "Undo", "Save", "Add note", "Cancel", "Edit", "Delete", "Start", "Pause", "Close",
    "History", "Retire", "Refresh", "Refreshing",
  ],
  Skills: [
    "Add", "Adding", "Search", "Added", "Add to …", "Edit", "Check for updates", "Delete", "Save", "Cancel", "Remove pack",
    "Add a skill", "Discard draft",
  ],
  "Scrum Master": ["Undo", "Undoing", "Scrum Master", "Show all …"],
  // Settings itself: the tabs along the top (each tab is a screen of its own below, BOS-442).
  Settings: [
    // "Server and runner" is the name of the last group, not a page (BOS-1492); its pages are Updates … Devices and privacy.
    "Funding", "Secrets", "Account", "Tools and deploys", "Reviews", "Team and CEO", "Watchdog", "Permissions",
    "Updates", "Limits and checks", "Runner", "Email", "This server", "Devices and privacy", "Import and export",
    "Server and runner",
    "Run the setup wizard",
  ],
  "Server and runner": [
    "Reconnect runner", "Start runner", "Restart", "Stop", "Copy token", "Issue a new runner token", "Register a runner",
    "Review and deploy", "Check for updates now", "Build and update runners", "Deploy to staging", "Cancel queued runner update", "Save", "Save add-ons", "Cancel the update", "Update runners (finish runs first)",
    // The update wait (BOS-420): the same button reads by phase.
    "Stop making room", "Lift the hold now",
    // The server-wide hold (BOS-836); Resume is on the banner every screen shows while it is on.
    "Stop all work",
    // The safety cards under the runner (BOS-938).
    "Keep agents stopped", "Run agents without the network guard", "Run agents without the fence",
    // Ask every running agent to stop cleanly before an update (BOS-929).
    "Ask agents to wrap up", "Cancel wrap-up", "Stop this run",
    // Updates (BOS-647): a fresh copy of the version that runs, through the host deployer.
    "Restart the server",
    // This host: confirm a fact only the owner can give.
    "Confirm",
    // This host (BOS-924): the reported facts fold away behind a one-line header; the arrow opens them.
    "Reported facts",
    // Your devices (BOS-641): measure this browser and keep or drop its screen profile.
    "Measuring", "Record this device", "Rename", "Forget",
    // Outgoing email (BOS-1387).
    "Turn off", "Send test email",
    // Checks → Check workers (BOS-1435): add one (its token is shown once), change, turn on or off, remove.
    "Add a check worker", "Add", "Done", "Change", "Turn on", "Remove", "Cancel",
    // BOS-1550: copy the ready-filled compose file shown after adding.
    "Copy compose file",
  ],
  // Tool servers and deploy targets (a funding source is added on Funding, not here).
  "Tools and deploys": [
    "Remove", "Add tool server", "Add target", "Edit", "Delete", "Save", "Cancel",
    // The Penpot form (BOS-1582).
    "Set up Penpot", "Change Penpot", "Save Penpot", "Remove Penpot", "Remove export login",
    // Removing a deploy target that has past deploys (BOS-2158).
    "Remove anyway",
  ],
  // Who approves and reviews work at each risk level, and whether it moved the goal.
  Reviews: ["Reset to defaults"],
  // Standing rules, the CEO chapters, the advice setting, nudges, the run time limit and the retros.
  "Team and CEO": ["Pause company", "Resume company", "Cancel", "Edit", "Start a new chapter", "Clear", "Undo last change", "Discard draft", "Run a retro now"],
  // The permission rules page, its advice mode, the second opinion and the fence.
  Permissions: ["Delete", "Edit", "Save", "Cancel", "Ask the CEO to draft it", "Add rule", "Check", "Test", "Choose Off: run agents without the fence"],
  // The Scrum Master's watchdog: its limits, its record-only rehearsal and its safety cap.
  Watchdog: ["Switch off", "Switch back on", "Switch on", "Test on the past 48 hours"],
  "Import and export": ["Check name", "Import as a new company", "Open …"],
  // The owner's password and other logins (BOS-2159).
  Account: ["Change password", "Sign out other devices"],
  // Spend, the hold and the Claude accounts' order, and adding or editing a funding source.
  Funding: ["Save", "Add funding source", "Add limit", "Edit", "Delete", "Cancel"],
  // Every stored credential: adding one (the Claude token included), granting and rotating it.
  Secrets: ["Revoke", "Rotate", "Delete", "Check with Claude", "Check", "Remove"],
  // The "What this shows" card's button when there is too little data (BOS-1937).
  Workflow: ["Show the last …"],
} as const satisfies Record<string, readonly string[]>;

export type OwnerScreen = keyof typeof OWNER_CONTROLS;

/**
 * The form fields the owner can fill in, by screen (BOS-442): each field's label as the screen shows it. The lint
 * (R8) checks that a step naming a field sends the owner to a screen that has it, and (R13) that the step gives its
 * value. The same test as the buttons reads every <label> in apps/web/src, so this list can't go stale either.
 */
export const OWNER_FIELDS = {
  "Any screen": ["New company name"],
  "Log in": ["Username", "Password"],
  Setup: [
    "Company name", "What it's for", "Project name", "The CEO", "Title", "Description", "Give it to",
    // The credentials, funding and project panels Setup shares with Secrets, Access and funding, and Projects.
    "Claude setup token", "Add", "Value", "Name", "Variable name",
    "Editing …", "New funding source", "Kind", "Provider", "Monthly grant (USD)", "Cycle starts on",
    "Reviews for this project", "Cost cap per task (USD)", "Monthly spend cap (USD)", "Git repo", "Default branch",
    "When work is approved", "Before merging, Boss Man will", "For high-risk work, also",
  ],
  Decisions: [
    "Harness", "Provider", "Model", "Paid from", "What went wrong (if a step failed)", "Note for",
    "Why (shown on the Changes table, required)", "Wiki page that explains it (optional)",
    "Your answer, in your own words. It goes to …", "What's unclear (optional, one line)",
    "Every agent in this company",
    "Your one-line reason, or the corrected lesson (needed for Edit)",
  ],
  Notifications: [
    "Company", "Quiet hours: pages and asks become flags, flags become notes", "From", "Until", "Time zone",
    "Per agent, per hour, before the rest become notes", "Send to my phone through my own ntfy server", "Send to my phone",
    "Also send flags (normal priority)", "Topic",
    "Access token", "Remove the saved token", "Boss Man's address on your phone, so a tap opens the evidence",
    "Offer an Approve button on simple agent questions", "My phone",
  ],
  Board: [
    "Column name", "Title", "What problem does it solve, and for whom", "Description",
    "Done when (one acceptance criterion per line)", "Objective or milestone", "Ask the CEO to plan it", "Part of feature",
    "Assign to", "Risk", "Project", "Assigned to", "Feature", "Spending limit per month (USD)", "At the limit",
  ],
  Ticket: [
    "To", "Feature", "Milestone", "Make it wait on", "Acceptance criteria, one per line",
    "What you have to do, one step per line", "Why it matters (opens the card)", "If you skip it", "What should the agent change",
    "Lesson learned (optional) — the CEO decides whether to add it to the project brief, and you are told the outcome", "Doesn't need code changes",
    "Priority 1", "Blocked until (optional)", "Why (one line)", "Written by", "Assigned to", "Risk", "Size", "Watcher",
  ],
  // The project settings (ProjectRow): on a project's Config tab and, for every project, on the Projects page.
  Config: [
    "Reviews for this project", "Name", "Cost cap per task (USD)", "Monthly spend cap (USD)", "Git repo", "Default branch",
    "When work is approved", "Before merging, Boss Man will", "For high-risk work, also",
  ],
  Projects: [
    "Reviews for this project", "Name", "Cost cap per task (USD)", "Monthly spend cap (USD)", "Git repo", "Default branch",
    "When work is approved", "Before merging, Boss Man will", "For high-risk work, also",
    // The GitHub feedback watcher panel (BOS-1393).
    "Watch this repo", "GitHub repo (owner/name)", "Check every (minutes, at least 15)", "Issues", "Discussions",
    "Skip posts by these GitHub logins (yours, Boss Man's account)",
    "Security alerts (this project owns the repo's alerts)",
  ],
  Roadmap: ["Milestone", "Target date", "New milestone", "Company", "New objective", "Priority", "Where", "Show done work"],
  Wiki: [
    "Title", "Folder", "Page text, in Markdown", "Search the wiki", "Search by meaning as well as words",
    "Also search your past answers by meaning", "Also search tickets and the CEO's earlier advice by meaning", "Provider address",
    "Model (768 dimensions)", "API key", "Search", "From",
  ],
  Features: [
    "Weight of demand", "The CEO triages new feedback (each batch costs a run)", "New criterion", "Weight", "New area",
    "New feature", "Area", "Sort by", "Show released and declined", "New task", "Project", "Risk", "Description", "Status",
    "Effort", "Subfeature of", "Objective or milestone", "Roadmap column", "Rank",
    "Priority 1: every open task of it goes first, and you get one page when all of it has merged",
    "Show on the feedback portal, where visitors can vote on it", "Keep off the portal (sensitive)", "Why it's kept off (optional)", "Public title (optional)", "Public summary", "Not shown yet",
  ],
  Feedback: [
    "Feedback, as they said it", "Title (optional)", "From (optional)", "Their email (optional)", "Segment (optional)",
    "Came in by", "Feature", "Portal on", "Heading", "Replace", "Add logo", "Introduction", "Link back to your website (optional)", "Link text (optional)", "Search feedback",
    "Visitors must click a link we email them before a post, comment or vote counts", "Link works for (hours)",
    "Remember a confirmed browser for (days)", "Open this portal at the public address itself",
  ],
  "Feedback portal": [
    "Your name (optional)", "Email, if you'd like to hear back (optional)", "What would it let you do",
    "Your idea, in a few words", "What problem would it solve for you", "Website", "Your email",
  ],
  Agents: [
    "Thinking", "Blank", "Name", "Job title", "Agent", "Model", "Paid from", "Instructions", "Upload a picture", "Title",
    "Note", "Review by (optional)", "Why (what you said)", "What waits for you from the CEO",
  ],
  Skills: [
    "GitHub link to a repository, a folder or a SKILL.md", "Name", "What it does and when to use it",
    "Instructions, in Markdown", "A skill folder, its files, or a .zip",
  ],
  "Server and runner": [
    "Across all companies (1 to 32)", "In one company (1 to 16, no more than the number above)",
    "Background agents at once (0 to 16)",
    // Settings → Server and runner → Private details to block (BOS-979).
    "New list (replaces the saved one; leave empty and save to clear it)",
    // Settings → Server and runner → Agents at once (BOS-1029).
    "Tickets in progress per agent (leave empty for no limit)",
    "Tickets in progress, whole company (leave empty for no limit)",
    // Settings → Server and runner → Main's CI (BOS-1072).
    "Watch main's CI and open tickets for failures",
    // Settings → Server and runner → Tickets in progress: the start hold (BOS-1489).
    "Hold new starts while this many merges are waiting (leave empty for off)",
    "Hold new starts while this many quick checks are queued (leave empty for off)",
    "Hold new starts when this many need you (leave empty for off)",
    // Settings → Checks: who runs the quick check, and how many at once (BOS-798).
    "Each agent runs its own", "Boss Man runs them", "Checks at once (1 to",
    // Settings → Checks: hold each merge until GitHub CI passes on it (BOS-1070).
    "Wait for GitHub CI before merging",
    // Settings → Checks: the merge train switch (BOS-1366).
    "Merge approved work in the order it was approved",
    // Settings → Checks: how long a background-lane merge gives way to ordinary ones (BOS-1803).
    "Background lane gives way for (minutes, 0 to",
    // Settings → Checks: carry a passed merge across file-disjoint main moves, and the landing turn (BOS-1762).
    "Land passed merges when main moved elsewhere", "Landing turn",
    // Settings → Checks: rebuild a waiting merge on a moved main while it waits (merge_retarget; BOS-1344/1820/1821, BOS-1900).
    "Rebuild waiting merges when main moves",
    // Settings → Checks → Check workers (BOS-1435): one machine's form.
    "Name", "Checks at once on this machine (1 to", "Test threads per check (optional)", "Memory per check, in GB (optional)",
    // Settings → Checks: each machine's split between merge checks and quick checks (BOS-1602).
    "Takes", "Kept for merge checks (0 to",
    // Workspace disk.
    "Most disk to use (GB)",
    // Settings → Server and runner → Outgoing email (BOS-1387).
    "Server", "Port", "Security", "Username", "Password or token", "From address", "From name (optional)", "Send a test email to",
  ],
  // Tool servers and deploy targets.
  "Tools and deploys": [
    "Server name", "Server URL", "Transport", "Token secret", "Header name", "Header value",
    // Deploy targets (BOS-619), with the tag that moves after a successful deploy.
    "Name", "Kind", "Address", "Production (you approve every deploy, and high-risk work must deploy to staging first)",
    "Requires approval (you approve each deploy here too)", "After a successful deploy, move tag", "Tag name", "In the repo of",
    // The Penpot form (BOS-1582).
    "Penpot address", "Access token", "Export email (optional)", "Export password (optional)",
  ],
  // Who reviews at each risk level, and the "did it move the goal?" check.
  Reviews: ["Ask after (days)"],
  // The settings that shape how the team works day to day.
  "Team and CEO": [
    "Prefix", "Minutes the CEO has", "Nudges per hour", "Most minutes per run", "Who runs it",
  ],
  // The Scrum Master's watchdog.
  Watchdog: ["Record only (rehearse)", "Scrum Master"],
  // The permission rules page, the advice mode, the second opinion and the fence's mode (BOS-325).
  Permissions: [
    "Rules for", "What should this rule do", "New rule", "Rule name", "Command matches (regex)", "Tool title matches (regex)", "Then", "An agent of",
    "Ask a model for a second opinion", "Provider address", "Model", "API key", "Fence", "Advice",
  ],
  Account: ["Current password", "New password", "New password again"],
  "Import and export": [
    "Include the wiki", "Tickets", "Package", "Company name", "Funding for every agent",
    // The import preview's opt-in for a tool server that reaches the stack or the private network (BOS-335 follow-up).
    "I understand this gives the runner a direct path to Boss Man's own services or your private network, and I want it anyway",
  ],
  Funding: [
    // "I have top-up credit" is the same setting on a Synthetic plan's card (BOS-934).
    "Hold routine work at", "I have extra usage", "I have top-up credit", "Can trigger the hold",
    "Order (1 is used first; leave empty to keep this account out of the list)", "Login for this account",
    // Adding or editing a funding source (BOS-1019: it lives here, not on a separate tab).
    "Editing …", "New funding source", "Kind", "Provider", "Monthly grant (USD)", "Cycle starts on",
    // A project's monthly spending limit (its Budget tab, BOS-1564).
    "Spending limit per month (USD)", "At the limit",
  ],
  // "Add" is the kind of credential to add (Claude token, GitHub token, Other…).
  Secrets: ["Add", "Value", "Name", "Variable name", "Rotate: new value"],
  Workflow: ["Show each agent"],
} as const satisfies Partial<Record<OwnerScreen, readonly string[]>>;

/** The side menu, in order (Sidebar.tsx). */
export const OWNER_MENU = [
  "Dashboard", "Decisions", "Notifications", "Chat", "Projects", "Roadmap", "Features", "Feedback", "Plan", "Merge queue",
  "Wiki", "Agents", "Skills", "Engagements", "Runs", "Scrum Master log", "Workflow report", "Settings",
] as const;
/** The tabs along the top of a screen (Settings.tsx TABS, Board.tsx PROJECT_TABS). */
export const OWNER_TABS = {
  Settings: [
    "Funding", "Secrets", "Account", "Tools and deploys", "Reviews", "Team and CEO", "Watchdog", "Permissions",
    "Updates", "Limits and checks", "Runner", "Email", "This server", "Devices and privacy", "Import and export",
  ],
  Board: ["Kanban", "Budget", "Config"],
} as const;

/**
 * The section headings on each tab, as the page shows them (Section titles, h3 headings and the "Advanced" folds). A
 * card's path may name one after its tab ("Settings → Server and runner → This server → Network guard"); a path part
 * that is none of a tab, a heading, a button or a field is refused (R8, BOS-1649). `owner-control-list.test.ts` reads
 * the web app and fails when an entry here is no longer on its page or a literal Section title is missing here.
 */
export const OWNER_SECTIONS = {
  Funding: ["Funding sources", "Budgets", "What the provider controls"],
  Secrets: ["All stored secrets"],
  "Tools and deploys": ["Tool servers (MCP)", "Penpot", "Deploy targets", "If the git host protects the tag"],
  Reviews: ["Reviews"],
  "Team and CEO": [
    "Pause this company", "Standing rules", "CEO chapters", "Asking the CEO for advice", "Nudges", "Run time limit", "Workflow retros", "Ticket references",
    "Did it move the goal?", "Cleaning up temp files",
  ],
  Watchdog: ["Watchdog"],
  Permissions: ["Permission rules", "Advice on permission cards", "Second opinion", "Second opinion from a model (optional)", "Agent fence", "Setting up a host", "Try a command"],
  Updates: ["Updates", "Other actions", "Now running", "Recent updates", "Stop all work", "What the host said"],
  "Limits and checks": ["Agents at once", "Tickets in progress", "Checks", "Check workers"],
  Runner: ["Runner", "Add-ons", "Workspace disk"],
  Email: ["Outgoing email", "Main's CI"],
  "This server": ["Server", "This host", "Facts only you can give", "Network guard", "Allowed automatically", "Extra lines from your .env"],
  "Devices and privacy": ["Your devices", "Private details to block"],
  "Import and export": ["Import a company"],
  Account: ["Change password", "Sign out other devices"],
  Budget: ["Spending limit", "Pay-as-you-go spend", "On your subscriptions", "Tokens", "Costliest tasks"],
} as const satisfies Record<string, readonly string[]>;
