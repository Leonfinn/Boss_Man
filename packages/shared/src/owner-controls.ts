/**
 * The controls the owner can press in the web app, by screen (BOS-421, DR-009 L6). The owner-card lint refuses a
 * card that tells the owner to press something not on this list (`lintOwnerSteps`, rule R6), so a card can't send
 * them to a button that doesn't exist (3 Nov 15:10, "Overrule and merge").
 *
 * `apps/server/test/owner-controls.test.ts` reads every <button> in apps/web/src and fails when a label is missing
 * here or an entry here no longer has a button, so a change to a button's text must change this list too.
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
    "Agents", "Skills", "Runs", "Scrum Master", "Workflow", "Engagements", "Settings",
    "Switch company", "Create", "New company", "Close menu", "Menu …", "Turn on browser notifications", "Log out",
    "Save", "Saving", "Saved", "Attach file", "Attaching", "Remove", "Try again", "OK", "Cancel",
  ],
  "Log in": ["Create owner account", "Log in"],
  Setup: [
    "Create the company", "Add the project", "Check the token against …", "Add the task to …", "Continue", "Dismiss",
    "Back", "Next", "Skip for now", "Finish", "I know what I'm doing, let me get on with it",
  ],
  Decisions: [
    "Show less", "Show all …", "Save and approve", "Cancel", "Edit these values before approving", "All companies",
    "Reassign to the one I picked", "Let the CEO decide", "Back to the options", "Write my own answer", "Use suggestion",
    "Send my answer", "Ask the CEO for advice",
    // Under each command in a step (the label is set in code, so the test can't read it).
    "Copy",
  ],
  Notifications: ["Mark read", "Send a test to my phone", "All", "Unread", "Read", "Mark these read", "Mark all read", "Clear filters", "Try again"],
  Chat: ["Ask the CEO", "Send"],
  Board: [
    "Save", "Cancel", "New feature", "New task", "Add feature", "Add and start", "Add to backlog",
    "Let the CEO question me first", "Add task", "All", "Features", "Tasks", "Working now", "Show fewer",
    "Show all done tasks", "Run now",
  ],
  Ticket: [
    "Save criteria", "Done", "Add a line", "Edit criteria", "Send it back", "Cancel", "Approve",
    "Approve and open a pull request", "Approve and merge", "Request changes", "Run now", "Description", "Edit",
    "Save description", "Refresh all changes", "All changes", "Refresh the last turn", "The last turn", "Try merging now",
    "Show", "Hide", "Block", "Save", "Check now", "Clear", "Schedule a check",
    // The ticket's conversation, links, outputs and reviews.
    "Send", "Interrupt and send", "Stop", "Add", "Remove", "Reviews",
  ],
  Run: ["Send after this turn", "Interrupt and send", "Stop run"],
  Roadmap: ["Save", "Delete", "Add a milestone", "Add", "Cancel", "Mark done", "Remove", "Reopen", "No date …", "Add objective"],
  Plan: ["Refresh"],
  Wiki: [
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
  Settings: [
    // The tabs along the top.
    "Server and runner", "Access and funding", "Reviews and CEO", "Import and export", "Funding", "Rules", "Secrets",
    "Reconnect runner", "Start runner", "Restart", "Stop", "Copy token", "Issue a new runner token", "Register a runner",
    "Save", "Check with Claude", "Check", "Remove", "Add tool server", "Edit", "Delete", "Add", "Cancel", "Unarchive",
    "Archive", "Re-detect", "Refresh brief", "Write brief", "Open …", "Switch off", "Switch back on", "Switch on",
    "Test on the past 48 hours", "Run a retro now", "Test", "Start a new chapter", "Deploy latest",
    "Build and update runners", "Cancel the update", "Update runners (finish runs first)", "Check name",
    "Import as a new company", "Run the setup wizard", "Reset to defaults",
    // Funding, Rules and Secrets, shown inside Settings.
    "Ask the CEO to draft it", "Add rule", "Revoke", "Rotate",
  ],
} as const satisfies Record<string, readonly string[]>;

export type OwnerScreen = keyof typeof OWNER_CONTROLS;
