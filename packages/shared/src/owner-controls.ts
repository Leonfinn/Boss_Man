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
    "Agents", "Skills", "Runs", "Merge queue", "Scrum Master", "Workflow", "Engagements", "Settings",
    "Switch company", "Create", "New company", "Close menu", "Menu …", "Turn on browser notifications", "Log out",
    "Save", "Saving", "Saved", "Attach file", "Attaching", "Remove", "Try again", "OK", "Cancel",
    // The owner's message box (Ticket, Board, Chat, Decisions and Run show it).
    "Send as a .txt file", "Sending",
    // A picture opened from Markdown text.
    "Actual size", "Fit to window",
    // The banner shown when Boss Man was updated after the page was opened (BOS-550).
    "Reload",
  ],
  "Log in": ["Create owner account", "Log in"],
  Setup: [
    "Create the company", "Add the project", "Check the token against …", "Add the task to …", "Continue", "Dismiss",
    "Back", "Next", "Skip for now", "Finish", "I know what I'm doing, let me get on with it",
    // The runner, credentials, funding and project panels Setup shares with Settings and Projects.
    "Reconnect runner", "Start runner", "Restart", "Stop", "Copy token", "Issue a new runner token", "Register a runner",
    "Save", "Check with Claude", "Check", "Remove", "Edit", "Delete", "Add", "Cancel", "Re-detect",
  ],
  Decisions: [
    "Show less", "Show all …", "Save and approve", "Cancel", "Edit these values before approving", "All companies",
    "Reassign to the one I picked", "Let the CEO decide", "Back to the options", "Write my own answer", "Use suggestion",
    "Send my answer", "Ask the CEO for advice",
    // Under each command in a step (the label is set in code, so the test can't read it).
    "Copy",
  ],
  Notifications: ["Mark read", "Send a test to my phone", "All", "Unread", "Read", "Mark these read", "Mark all read", "Clear filters", "Try again", "Show less", "Show all …"],
  Chat: ["Ask the CEO", "Send"],
  // A project's page (Projects → a project). Its tabs along the top, then the Kanban tab's buttons.
  Board: [
    "Kanban", "Budget", "Config",
    "Save", "Cancel", "New feature", "New task", "Add feature", "Add and start", "Add to backlog",
    "Let the CEO question me first", "Add task", "All", "Features", "Tasks", "Working now", "Show fewer",
    "Show all done tasks", "Run now",
  ],
  Ticket: [
    "Save criteria", "Done", "Add a line", "Edit criteria", "Send it back", "Cancel", "Approve",
    "Approve and open a pull request", "Approve and merge", "Request changes", "Run now", "Description", "Edit",
    "Save description", "Refresh all changes", "All changes", "Refresh the last turn", "The last turn", "Try merging now",
    "Show", "Hide", "Block", "Save", "Check now", "Clear", "Schedule a check",
    "Mark urgent", "Marked urgent", "Edit steps", "Save steps",
    // The ticket's conversation, links, outputs and reviews.
    "Send", "Interrupt and send", "Stop", "Add", "Remove", "Reviews",
    // The Scrum Master's log of this ticket.
    "Undo", "Undoing", "Scrum Master", "Show all …",
  ],
  // A project's Config tab (repo and merge-check settings, brief, archive), and the Projects page, which shows
  // the same settings for every project. The merge-check setting ("Before merging, Boss Man will…") is here,
  // not under Settings.
  Config: ["Re-detect", "Refresh brief", "Write brief", "Archive", "Unarchive"],
  Projects: ["Open …", "Unarchive", "Re-detect"],
  Run: ["Send after this turn", "Interrupt and send", "Stop run"],
  Roadmap: ["Save", "Delete", "Add a milestone", "Add", "Cancel", "Mark done", "Remove", "Reopen", "No date …", "Add objective"],
  Plan: ["Refresh"],
  Wiki: [
    "Show older versions", "Loading",
    "Write", "Preview", "Cancel", "Edit", "New page here", "History …", "Delete", "Put this version back",
    "Back to the current one", "Re-embed all", "Test", "Hide pages", "Show pages", "New page",
  ],
  Features: [
    "Remove", "Add", "Add feature", "Criteria and areas", "Create task", "Save", "Cancel", "Edit title and description",
    "Save summary", "Delete feature",
  ],
  Feedback: [
    "Add feedback", "Add to the inbox", "Cancel", "Use the whole note", "Create …", "Back to the list", "Unlink",
    "Link to …", "Done: mark processed", "Back to unprocessed", "Archive", "Delete", "Copy", "New link", "Remove",
    "Feedback portal", "Search", "Anonymous …",
  ],
  "Feedback portal": ["Edit your comment", "Tell us why", "Remove my vote", "Send", "Cancel", "Send idea"],
  Agents: [
    "Refresh models", "Asking the runner", "Choose from the list", "Hire …", "Use the default", "Replace with the current …",
    "Fill in from the …", "Rehire", "Undo", "Save", "Add note", "Cancel", "Edit", "Delete", "Start", "Pause", "Close",
    "History", "Retire", "Refresh",
  ],
  Skills: [
    "Add", "Adding", "Search", "Added", "Add to …", "Edit", "Check for updates", "Delete", "Save", "Cancel", "Remove pack",
    "Add a skill",
  ],
  "Scrum Master": ["Undo", "Undoing", "Scrum Master", "Show all …"],
  // Settings itself: the tabs along the top (each tab is a screen of its own below, BOS-442).
  Settings: [
    "Server and runner", "Access and funding", "Reviews and CEO", "Import and export", "Funding", "Rules", "Secrets",
    "Run the setup wizard",
  ],
  "Server and runner": [
    "Reconnect runner", "Start runner", "Restart", "Stop", "Copy token", "Issue a new runner token", "Register a runner",
    "Deploy latest", "Build and update runners", "Save", "Cancel the update", "Update runners (finish runs first)",
    // Updates (BOS-647): a fresh copy of the version that runs, through the host deployer.
    "Restart the server",
    // This host: confirm a fact only the owner can give.
    "Confirm",
    // Your devices (BOS-641): measure this browser and keep or drop its screen profile.
    "Measuring", "Record this device", "Rename", "Forget",
  ],
  // Tool servers and funding sources (a new funding source is added here, not on the Funding tab).
  "Access and funding": ["Remove", "Add tool server", "Edit", "Delete", "Save", "Add", "Cancel"],
  "Reviews and CEO": [
    "Reset to defaults", "Save", "Switch off", "Switch back on", "Switch on", "Test on the past 48 hours", "Run a retro now",
    "Cancel", "Edit", "Test", "Start a new chapter",
    // Standing rules.
    "Clear", "Undo last change",
  ],
  "Import and export": ["Check name", "Import as a new company", "Open …"],
  // Spend, the hold and the Claude accounts' order.
  Funding: ["Save"],
  Rules: ["Delete", "Ask the CEO to draft it", "Add rule", "Check"],
  // Every stored credential: adding one (the Claude token included), granting and rotating it.
  Secrets: ["Revoke", "Rotate", "Delete", "Save", "Check with Claude", "Check", "Remove"],
  Workflow: [],
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
    "Add", "Value", "Name", "Variable name",
    "Editing …", "New funding source", "Kind", "Provider", "Monthly grant (USD)", "Cycle starts on",
    "Reviews for this project", "Cost cap per task (USD)", "Monthly spend cap (USD)", "Git repo", "Default branch",
    "When work is approved", "Before merging, Boss Man will", "For high-risk work, also",
  ],
  Decisions: [
    "Harness", "Provider", "Model", "Paid from", "What went wrong (if a step failed)", "Note for the agent (if you send it back)",
    "Why (shown on the Changes table, required)", "Wiki page that explains it (optional)",
    "Your answer, in your own words. It goes to …", "What's unclear (optional, one line)",
    "Every agent in this company",
  ],
  Notifications: [
    "Company", "Quiet hours: pages and asks become flags, flags become notes", "From", "Until", "Time zone",
    "Per agent, per hour, before the rest become notes", "Send to my phone through my own ntfy server", "Topic",
    "Access token", "Remove the saved token", "Boss Man's address on your phone, so a tap opens the evidence",
  ],
  Board: [
    "Column name", "Title", "What problem does it solve, and for whom", "Description",
    "Done when (one acceptance criterion per line)", "Objective or milestone", "Ask the CEO to plan it", "Part of feature",
    "Assign to", "Risk", "Project", "Assigned to", "Feature",
  ],
  Ticket: [
    "To", "Feature", "Milestone", "Make it wait on", "Acceptance criteria, one per line",
    "What you have to do, one step per line", "What should the agent change",
    "Lesson learned (optional) — the CEO decides whether to add it to the project brief, and you are told the outcome", "Doesn't need code changes",
    "Urgent", "Blocked until (optional)", "Why (one line)", "Written by", "Assigned to", "Risk", "Size", "Watcher",
  ],
  // The project settings (ProjectRow): on a project's Config tab and, for every project, on the Projects page.
  Config: [
    "Reviews for this project", "Name", "Cost cap per task (USD)", "Monthly spend cap (USD)", "Git repo", "Default branch",
    "When work is approved", "Before merging, Boss Man will", "For high-risk work, also",
  ],
  Projects: [
    "Reviews for this project", "Name", "Cost cap per task (USD)", "Monthly spend cap (USD)", "Git repo", "Default branch",
    "When work is approved", "Before merging, Boss Man will", "For high-risk work, also",
  ],
  Roadmap: ["Milestone", "Target date", "New milestone", "Company", "New objective", "Priority", "Where", "Show done work"],
  Wiki: [
    "Title", "Folder", "Page text, in Markdown", "Search the wiki", "Search by meaning as well as words", "Provider address",
    "Model (768 dimensions)", "API key", "Search",
  ],
  Features: [
    "Weight of demand", "The CEO triages new feedback (each batch costs a run)", "New criterion", "Weight", "New area",
    "New feature", "Area", "Sort by", "Show released and declined", "New task", "Project", "Risk", "Description", "Status",
    "Effort", "Subfeature of", "Objective or milestone", "Roadmap column", "Rank",
    "Show on the feedback portal, where visitors can vote on it", "Public summary", "Show publicly",
  ],
  Feedback: [
    "Feedback, as they said it", "Title (optional)", "From (optional)", "Their email (optional)", "Segment (optional)",
    "Came in by", "Feature", "Portal on", "Heading", "Replace", "Add logo", "Introduction", "Search feedback",
  ],
  "Feedback portal": [
    "Your name (optional)", "Email, if you'd like to hear back (optional)", "What would it let you do",
    "Your idea, in a few words", "What problem would it solve for you", "Website",
  ],
  Agents: [
    "Thinking", "Blank", "Name", "Job title", "Agent", "Model", "Paid from", "Instructions", "Upload a picture", "Title",
    "Note", "Why (what you said)", "What waits for you from the CEO",
  ],
  Skills: [
    "GitHub link to a repository, a folder or a SKILL.md", "Name", "What it does and when to use it",
    "Instructions, in Markdown", "A skill folder, its files, or a .zip",
  ],
  "Server and runner": ["Across all companies (1 to 32)", "In one company (1 to 16, no more than the number above)"],
  "Access and funding": [
    "Server name", "Server URL", "Transport", "Token secret", "Header name", "Header value",
    "Editing …", "New funding source", "Kind", "Provider", "Monthly grant (USD)", "Cycle starts on",
  ],
  "Reviews and CEO": [
    "Prefix", "Record only (rehearse)", "Scrum Master", "Ask after (days)", "Who runs it", "Minutes the CEO has", "Advice",
    "Ask a model for a second opinion", "Provider address", "Model", "API key", "Nudges per hour", "Disk cap (GB)",
    // The agent fence's mode (BOS-325).
    "Fence",
  ],
  "Import and export": [
    "Include the wiki", "Tickets", "Package", "Company name", "Funding for every agent",
    // The import preview's opt-in for a tool server that reaches the stack or the private network (BOS-335 follow-up).
    "I understand this gives the runner a direct path to Boss Man's own services or your private network, and I want it anyway",
  ],
  Funding: [
    "Hold routine work at", "I have extra usage", "Can trigger the hold",
    "Order (1 is used first; leave empty to keep this account out of the list)", "Login for this account",
  ],
  Rules: ["Rules for", "What should this rule do", "New rule", "Command matches (regex)", "Tool title matches (regex)", "Then", "An agent of"],
  // "Add" is the kind of credential to add (Claude token, GitHub token, Other…).
  Secrets: ["Add", "Value", "Name", "Variable name", "Rotate: new value"],
  Workflow: ["Show each agent"],
} as const satisfies Partial<Record<OwnerScreen, readonly string[]>>;

/** The side menu, in order (Sidebar.tsx). */
export const OWNER_MENU = [
  "Dashboard", "Decisions", "Notifications", "Chat", "Projects", "Roadmap", "Merge queue", "Plan", "Wiki", "Features",
  "Feedback", "Agents", "Skills", "Runs", "Scrum Master", "Workflow", "Engagements", "Settings",
] as const;
/** The tabs along the top of a screen (Settings.tsx TABS, Board.tsx PROJECT_TABS). */
export const OWNER_TABS = {
  Settings: ["Server and runner", "Access and funding", "Reviews and CEO", "Import and export", "Funding", "Rules", "Secrets"],
  Board: ["Kanban", "Budget", "Config"],
} as const;
