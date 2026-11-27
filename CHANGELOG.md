# What's new in Boss Man

The changes you will notice in Boss Man, newest first, in plain words. Each date lists the changes added that day, and its first line says which ready-made image has them. To get them, update your server (see `docs/23-updating.md`). This file is also the "What's new" page on the website.

> [!NOTE]
> **When you get each change.** If you built Boss Man from source, you get each change as soon as it is added: update your server to pick it up. If you installed the ready-made Docker images, a new image comes out once a week, on Tuesdays, with every change up to then. A newer change waits for the next weekly image, so a feature listed here may not be in your install yet.
>
> **Which do I have?** Open Settings → Server and runner → Updates. An image install says which image it runs there, for example "You run 0.1.0-beta.3". An install built from source shows no image number.

<!--
Release step: adding to this file is part of every release (Release Manager, on the "Release log: record" wake).

1. Start from what the live server runs, not from what reached main today: main moves faster than the deployer.
   In the release log (the newest page in the wiki's Releases folder), find the newest entry that says the website was
   "NOT republished". Cover every change from that entry's release (from its "was" commit) up to and including the newest
   live commit, using each entry's "Things you'll notice" line. Skip any change that already has a line on this page.
2. Add those changes under today's heading, "## 16 November 2026" (day, month in full, year). Make the heading if today has none.
   Newest day first. One heading per day: a second release that day adds to the same list.
   A new heading's first line, before its bullets, is the image label "**Not in an image yet:** comes with the next
   weekly image (Tuesdays)." with the bold part exactly so. On release day the dates the new image covers change to
   "**In image 0.1.0-beta.N**" (the full version, as the GitHub release title has it). A line counts as in an image when
   that release's commit already holds it, the same rule scripts/release-notes.sh uses. A day the weekly cut falls
   inside gets both labels: the not-yet label above the newer lines, then the image label above the older ones.
3. One line per change, written for an owner who is not a developer: what they will see or can now do, and "off by default"
   or "after you update the runners" when that applies. Leave out tests, CI, internal tooling, our own server's details,
   agent names and ticket numbers (the site build refuses a ticket number such as BOS-123).
4. Nothing to notice in this release? Add nothing.
5. Once it is merged, redeploy the website so the page shows it. This is part of the release, not a separate job:
   the release wake ("Release log: record") runs on every live commit, so republish from that commit before you finish it,
   and say in the log entry whether the site was republished. Run `scripts/publish-site.sh` (docs/18-website.md): it builds,
   deploys and sends the IndexNow notice of the changed pages in one go.
6. The install guide's "Last tested on ..." line comes from the release's Install test, which starts when the Release
   workflow ends and takes 10 minutes or more, so the publish in step 5 shows the previous result. Before you finish the
   wake, check the new release (`gh release view v<version>`, or the releases page): it has an `install-result.json` file
   once the test is done. Wait for it (schedule_check, do not poll). Since BOS-2787 the Install test's "site" job then
   republishes the site by itself (scripts/republish-site-after-install.sh); check the live guide shows the new date,
   version and minutes. Also read the release notes (`gh release view v<version>`) and the job (`gh run list
   --workflow install-test.yml --limit 3`, then `gh run view <id>`): a failed or skipped republish shows there, as a
   "Website republish FAILED" or "Website NOT republished" line and a red `site` job (a workflow cannot message Boss Man).
   On either line, run `scripts/publish-site.sh` a second time yourself and, for "NOT republished", raise a ticket for
   the Infrastructure Engineer to set up the "site" environment (docs/18-website.md). If the release title ends "(install test FAILED)", also raise a ticket for the CEO with
   `create_ticket` (project Development, risk high, size 1), saying which release failed. In the log entry say what the
   test gave (pass or fail, minutes) and whether the site was republished.
7. Record the docs check, on every Monday docs-vs-code check (BOS-2667) as well as on a release wake: the Release
   workflow's docs gate (BOS-2666, scripts/release-docs-gate.sh) refuses a release whose docs check does not cover the
   commit. The check is ONE line of its own, outside this comment and above the first dated heading: the words "Docs
   checked up to", then the full 40-character sha of the commit main was checked at, then a space and a hyphen run of two
   followed by a closing angle bracket, all wrapped in an HTML comment. Do not write that example line out in full here,
   or its closing marker ends this comment early and the rest of these steps show up in the changelog. Update the one
   recorded line each week; do not add a second one (the gate refuses a file with two). Put the sha itself in this release steps comment if you want a
   note of which check it came from. The rule (scripts/release-docs-gate.sh, rule 3): every commit after that sha up to the
   commit released may touch only the docs paths in scripts/release-docs-paths.txt. A code change after the checked sha
   must be checked and the line moved on before it can be released. On the weekly check, move the line only to a commit
   where the docs match the code; if the GitHub About box says an older stage than the code, tell the CEO before moving it.

7. Record your docs check (BOS-2666). Before a release can go out, compare the docs with the code: README.md, the
   guides in docs/, the website pages and the stage word everywhere (a beta says "beta", never "alpha"). Fix what is
   wrong, then keep exactly one line of this shape just under the "# What's new" heading, outside this comment: an HTML
   comment that reads "Docs checked up to", a space, the full sha of the newest commit you compared the docs with, and
   the closing arrows. Replace the sha each time; never add a second line. The Release workflow (the weekly one and the
   button) refuses any commit that is after that sha and touched anything but docs (scripts/release-docs-paths.txt), has
   an older stage word in the docs, or has no new "What's new" entry, and it stops with a one-line reason.
   The weekly run is Tuesday 10:00 UTC: record the check before then, or that week's release is refused.

8. Label the week's entries before the weekly release (BOS-2841). The Release workflow refuses a commit whose new entries are not
   labelled with the version it is releasing, so that the page never says "not in an image yet" about an image that has them. On
   the Monday docs check, with the next weekly version (the newest release's number plus one), run
   scripts/changelog-label.sh label 0.1.0-beta.N on main's CHANGELOG.md, commit it with the docs check, and let CI publish that
   commit's images. Running it twice does nothing the second time. The workflow cannot do it itself: a push with its own token
   starts no CI, so the labelled commit would have no images. A run refused for this reason says which lines to label; label them,
   wait for the new commit's images, and run the release again.

Check before committing: pnpm --filter @boss-man/site build (it stops on a heading that is not a date, or one out of order).
Remember to put an empty line after any line you add outside this comment, so the comment's own closing marker still closes it.
-->

<!-- Docs checked up to 688f2bc5a6c5f50810649a7cfa7af9e4bcec5d37 -->

## 27 November 2026

- The first time you move around Boss Man with the keyboard on a computer (pressing Tab outside a text box, or Ctrl K), a small tip at the bottom left says "Boss Man has keyboard shortcuts. Press ? any time to see them." Press Show shortcuts to open the list, or Got it (or Escape) to close it. It shows once per login, in any browser. It never shows on a phone, or if you have unticked "Use single-letter keys" in Settings → Account → Keyboard shortcuts.
- Pin the pages you open most. Press **Add to shortcuts** beside the title of any page inside Product, Team, Activity or Settings (for example Settings → Server and runner → Updates). The page then appears in a Shortcuts section at the top of the menu, on every device you sign in from. You can have up to 6. Press the button again, or Undo, to take it out. The menu is unchanged until you add one.
- **Edit** beside Shortcuts lets you rename, reorder or remove them. Nothing changes until you press Save.
- With the keyboard, press g then 1 to open your first shortcut, g then 2 for the second, and so on up to 6. The numbers follow the order in the menu. Press ? to see which number opens which page.

## 26 November 2026

**Not in an image yet:** comes with the next weekly image (Tuesdays).

- Keyboard shortcuts are easier to find. On a computer, press the keyboard button at the bottom of the menu, between Settings and Log out (or press ?), to see them, starting with the keys for the page you're on. Hover over a menu item to see its key, for example "Decisions (g then i)". Don't want single-letter keys, for example because you use voice control? Untick "Use single-letter keys" in Settings → Account → Keyboard shortcuts. The choice follows your login to every browser, and Ctrl K for search always works.
- A new beta release now goes out by itself every Tuesday morning (10:00 UTC), with that week's changes in its notes, as long as the newest code has passed its checks and its images are ready. If there is nothing new or nothing ready, it skips that week. You don't need to press anything.
- Boss Man is now in beta, no longer alpha. The website, the GitHub README and the contribution and security pages say so. You can install it from the ready-made Docker images on the GitHub releases page, or build it from the source.
- In the company brief (Wiki → Company brief), the "In flight" list now marks an agent whose run is on a ticket it does not own, review or have a card on: the line ends "(not assigned: woken by …)" with the reason it was started, so a stray run stands out. Runs on an agent's own tickets look as before.

## 25 November 2026

**In image 0.1.0-beta.3**

- In Settings → Server and runner → Updates, "Recent updates" no longer leaves older server updates stuck on "Waiting". The one now live says Live, and one a newer update took over from says Replaced. Each row shows its real number of changes, not "10 changes" on every row.
- The Updates banner describes the newest update that is waiting or queued, not an older "Update failed" message, and "Try again" is hidden while that newer update is pending.
- Pressing "Try again" after a failed update no longer makes a second Deploy card for a version you have already approved. It says that update is already approved and waiting, so you don't need to press again.
- If a server update's build fails on a brief registry or network error, it waits 20 seconds and builds once more instead of failing the whole update.
- After a server or runner update fails, its next update card is held back while the failure is looked into, so you are not offered a retry that may fail the same way. The card comes once a retry is known to be safe, or after 2 hours saying the cause is unknown, with Not now recommended. Cards you already had for that version are withdrawn, so you never see two cards that disagree.
- While an update is held like this, the Updates status box says so ("Held: … being looked into"). It shows nothing when there is no hold.
- The Roadmap's milestone timeline is redesigned: one row per milestone with one status, long titles that wrap without overlapping or being cut off, done milestones left out, and labelled charts. The timeline and the list now agree on each milestone's status and counts.
- A page waiting on an answer that never comes no longer sits on "Checking…" until you reload. The read gives up after 30 seconds and tries again by itself.
- When you answer a card that asked you for information, such as a log, a screenshot or a value, the result and next step now reach your chat and feed without you asking. If nothing arrives within 30 minutes, the CEO is asked to post it.
- Opening a milestone on the Roadmap shows a "What's left" list: every unfinished ticket in it, grouped as Waiting for you, Held up, Needs a look, Running or Being built, with who has it and what it waits on. A ticket held only by one of your cards has an Open card button.
- Each milestone on the Roadmap has a "CEO manages At risk" button, off by default. Turn it on and, when that milestone turns At risk or Late, the CEO is woken once to plan a remedy. It is not woken again while the status stays the same. A milestone with it off never wakes the CEO. "CEO manages At risk for all" turns it on for every milestone at once, and tells you first that each remedy costs a CEO run.
- The milestone's "CEO manages At risk" buttons read plainly: "Turn it on" where it said "Take it on", and "Turn it off" where it said "Turning it off".
- When the CEO manages a milestone that is At risk or Late, the CEO's plan for it now shows on the Roadmap, just under the line that says why the milestone is at risk. The plan goes away by itself once the milestone is back on track.
- After you answer a card and get its result, later corrections and updates about it also reach your chat, flagged, for 24 hours or until the matter is closed. A "still checking" note stays on the ticket.
- On the Merge queue page, a change whose own check has passed and that is now waiting for GitHub's tests shows a blue "On GitHub" tag instead of a grey "Waiting", with how long it has been there. Its line says what time its check passed.
- When a server or runner update fails, Boss Man opens an urgent ticket to find the cause, assigns it to your infrastructure engineer (or the CEO if you have none) and wakes them straight away. The Updates status says "Being looked into" only once their work has started. Until then it says "Not picked up yet" and who was woken when. If nobody starts within 15 minutes, the CEO is woken again. A second failure of the same update is added to the same ticket.
- If you press "Ask agents to wrap up" while a runner update is being built, the wrap-up now belongs to that update. The banner says "Wrapping up for the runner update", and the wrap-up lifts by itself when the update goes in, fails or is cancelled. Work on an urgent ticket still starts during a wrap-up.

## 24 November 2026

**In image 0.1.0-beta.3**

- The Feedback page has a summary above the list: how many notes are waiting to be triaged, how long the oldest has waited (with a link to it), and this week's notes by source. The list can be shown newest first or oldest first, the order is kept in the page address, "Show older" reads notes past the newest 50, and Download CSV follows the order you chose.
- Settings → Team and CEO → Standing rules has a "Past versions" fold with the last 20 changes: who made each, when, and how many lines were added and removed. Each opens a before/after view, and "Put this version back" restores it after asking you first. Undo still reverses it.
- Key results on the Roadmap keep their history. Each says "updated N days ago" (or "never updated"), shows a small trend, and is tagged "Not updated in 14 days" when it goes stale. A "Readings" fold lists every value with when and who. Key results from before this update say "never updated" until they get a new value.
- Settings → Server and runner → Runner has a "Connection, last 7 days" fold: the share of time the runner was connected, how many times it dropped, the longest gap, and the last 10 gaps with their length and how each ended. Gaps under 30 seconds are counted but not listed. The history builds up by itself.
- On the Projects page, each project's summary line says how many of its tickets are blocked, and the list can be sorted by name, most open, most blocked or latest merge. The sort is kept in the link.
- In Settings → Tools → Deploy targets, each target's row shows its newest deploy when that failed, was refused, is waiting for your approval or is running (for example "Latest: failed" and when), not only inside the Deploys fold.
- The Dashboard shows "Oldest block" with the ticket and how long it has been blocked, linking to the ticket that has waited longest. It only shows when something is blocked.
- Chat keeps answering while Boss Man or the runners update. It pauses only while a runner is actually being swapped, usually under a minute, and says by when it will answer again.
- Download CSV buttons on more lists: Engagements (following the search and state filter), Permission rules (with each rule's use in the last 7 and 30 days), a deploy target's deploy history in Settings → Tools and deploys → Deploy targets (following the status filter), the Projects list (each project's summary figures, in the sort you chose), and each funding source's "Last 8 weeks" fold in Settings → Funding.
- The Scrum Master log has a Download CSV button for the entries shown and an "Undone only" switch.
- On the Agents page, each agent's 30-day record also shows how many runs it had and how many failed, so an agent that keeps failing stands out. "N failed" opens the Runs page filtered to its failed runs.
- The Agents page has a "Team record, last 30 days" fold: every agent's record in one table, sortable by any column. The sort is kept in the link.
- The Runs page has a "Why runs started, last 7 days" fold with the runs and cost for each reason, and the finished list can be filtered by reason.
- A project's budget shows a forecast: "At this pace: about $X by the end of the month", with the limit and whether it stays under it or the day it reaches it. In the first 2 days of the month it says it is too early for a forecast.
- Settings → Server and runner → Updates → Server health has a "Database size, last 14 days" fold with each day's size and change. A day that grew by more than 10% is marked.
- In Decisions → Answered, each card says how long it waited for your answer (for example "answered after 3 h"), with a summary line: how many, the middle wait and the slowest kind. The Download CSV has a "Waited (minutes)" column.
- Settings → Watchdog can test its limits against the past 48 hours, 7 days or 14 days, shows a count for each kind of problem and how many cleared by themselves, and can hide the ones that cleared by themselves.
- On the Board, a card that other open cards wait on says "N waiting on this" (hover to see which). A "Holding others up" filter shows only those cards and is kept in the link, and the Download CSV has a "Waiting on this" column.
- The Features page has a "Last moved" column and marks a part-done feature "Stalled" when nothing has moved for over 3 days. You can show stalled features only and sort by last moved.
- The Wiki has a "Not changed in 30 days" list beside "Recently changed": the stalest pages first, with how long since their last change and who made it.
- Search results show each ticket's state (such as In progress, Done or Cancelled), and the Search page has an "Open tickets only" switch that is kept in the link.
- A run's page has "Find in this run" to search its transcript, with a match count and next and previous, and a "Show" filter for everything, messages, tool calls or problems.
- Each message in a ticket conversation has a "Copy link" button. Opening the link scrolls to that message and highlights it, loading older messages if needed.
- On the Merge queue's Quick checks tab, waiting checks are numbered after the running ones, so the last number matches the count on the tab.
- The Board loads fast again. It had been waiting for GitHub about every card before showing anything; build results now fill in on the next refresh.
- The Board layout is repaired: lane headers no longer squash or split "oldest 3 d", and the card footer no longer covers the agent's picture.
- The Dashboard's "Oldest block" line is laid out properly, and the ages in Board lane headers stay on one line.
- The merge banner's time to clear is more accurate and now gives a clock time ("the last one expected by about HH:MM"), or says "no estimate yet" when there is too little to go on.
- Settings → Server and runner → This server → This host names each container that is unhealthy or restarting and each fact the host has not reported, and no longer counts a container that is still starting after a runner swap.
- A wiki page's header says when it was created and by whom, as well as when it last changed and by whom. History shows how many versions there are and how many people edited the page.
- The Notifications page groups notices by day ("Today", "Yesterday", then the date), shows each day's unread count, and has "Mark this day read".
- In Settings → Server and runner → Updates, "Deploy to staging" has a help line saying it is optional, that agents deploy to staging themselves, and when you might press it.

## 23 November 2026

**In image 0.1.0-beta.3**

- Parts of Boss Man that are still loading now say "Loading…", and a part that fails to load says what failed and offers Retry, instead of a blank space or a false "none yet". This covers the Dashboard, ticket pages, the Spend report, Settings → Funding → Budgets, the Features page, a feature's own page, Settings → Devices, the Roadmap tabs, the Notifications page, four Wiki loads, Settings → Reviews, the CEO's chapters, and Settings → Tools.
- A ticket's Activity feed says "Loading the conversation" and offers Retry instead of looking empty.
- The Feedback page has a Download CSV button that exports every note in the current tab and search.
- The Board has a Download CSV button that exports the tickets shown, honouring search and filters.
- Wiki pages and a feature's own page now have a "Copy link" button, like ticket and run pages.
- A wiki page has a Download button that saves it as a Markdown file, and the Wiki page shows a list of the 10 pages most recently changed.
- The Chat header has a Download button that saves the whole conversation as a Markdown file.
- The Features page and the Agents page each have a search/filter box that narrows the list.
- The Engagements page filters to open engagements or one status.
- Each objective on the Roadmap has a Change button to rename it and set its priority.
- Recent updates on Settings → Server and runner has "Show older" to see updates past the newest 5, and the Notifications page has "Show older" to read notices past the newest 50.
- Settings → Tools now lets you change a tool server in place instead of removing and re-adding it.
- On the check machines settings, "Memory limit per check" now explains that it only limits a single check, and shows how much memory the machine has once the machine reports it (redeploy each check machine once after you update the runners).
- Agents on the OpenCode/Synthetic harness now get their skills after you update the runners, and the Skills page flags agents that can't load them.
- Boss Man asks once, in the product, for a second-account token so test-branch failures stop emailing you.
- The website install guide now leads with the ready-made Docker image install, keeping build-from-source as a second option.
- A new website guide explains moving a company from Paperclip, and the Paperclip guide now marks the export step confirmed on TrueNAS, adds an scp copy step, and runs the issues export from a throwaway Postgres container.
- Each release now runs an install test on a clean machine, and the install guide shows the date of the latest test, whether it passed and how long the install took.
- The Merge queue page shows which ticket holds the landing turn, what it is waiting for, and roughly when it and the tickets behind it will land.
- On the Board, clicking "N looks stuck" shows only those cards, with "Show all" to go back.
- Settings has a "Find a setting" box that narrows the menu by name, hint, help text and "On this page" entries.
- On the Dashboard, "N failed in 14 days" opens the Runs page already filtered to failed runs.
- Ctrl+K search now also finds agents and skills, each in its own group.
- The public roadmap portal's Released tab is now "What's new", with month headings and dates, and visitors can follow new releases in a feed reader.
- On the Roadmap, each milestone shows points done and left and an expected finish date at the last 4 weeks' pace, marked when that is after the target date.
- The Runs page has a "Waiting to start" list: which agents are queued, for which ticket, why, and how long they have waited.
- Settings → Tools → Deploy targets has "Deploy this version again" on a past successful deploy, a way back after a bad deploy. It still needs your approval.
- The Spend report has a "Costliest tickets" table for the chosen period, each linking to its ticket.
- A wiki page has a "Links" section: the pages it links to, with missing pages marked, and the pages that link to it.
- The Notifications page has a search box that finds notices by words in their title or text.
- Keyboard shortcuts on the Runs and Features pages: j and k move between rows, Enter opens one, and "?" lists the keys.
- The Skills page shows each skill's history: when it changed, who changed it, and a fold showing what changed.
- A run's page shows its model, tokens and cost in one line, and says "not reported" for any figure the harness did not give.
- The Workflow report has a "Week by week" table for the last 8 weeks.
- The card asking for a second GitHub account token now asks for a classic token (repo and workflow), because a collaborator cannot make a fine-grained one for the repo.

## 22 November 2026

**In image 0.1.0-beta.3**

- Settings → Account can now change your password and sign out every other device.
- Parts of Boss Man that are still loading now say "Loading…", and a part that fails to load says so and offers Retry, instead of showing a false "none yet". This covers the Tools, Rules, Credentials and Secrets settings and the Scrum Master log.
- The Board, Skills and Engagements lists load faster on big projects; older ones are behind a "Show older" button.
- The Board now has a Select mode: move, assign or prioritise several tickets at once.
- A "Copy link" button on ticket and run pages copies a link you can paste anywhere.
- Ctrl+K anywhere opens one search box that finds any ticket, wiki page or chat message.
- Long ticket conversations and agent chats have a "Load older messages" button past the newest 200 or 500.
- Dashboard "Needs you" items show how long the oldest one has waited and the usual wait. Decisions has an "Answered" list of cards you have already dealt with.
- Ticket pages show a "What Boss Man recorded" block: the runs, the spend, the last check and the files it touched.
- Run pages list every permission question that came up in that run, kept after a restart.
- On a permission card, "Allow" can now be for an hour, until midnight, or always.
- Each agent can be given working hours; outside them it is not started on new work. Off by default.
- Alerts can go to Slack, Discord or any webhook, chosen per kind of alert. You add and test each destination once in Settings → Notifications.
- If a background safety step keeps failing you get one alert instead of silence, and a sign-in lockout tells you once (at most three an hour). Spending over three times your usual rate gives you one alert a day naming the top agents and tickets.
- The morning summary now says what merged and what it cost, there is an optional weekly summary by email, and a "Send one now" button to try it without waiting for Monday.
- Settings → System has an optional "hold new starts when this many things need you" limit, and a stuck database query now fails fast with a clear message instead of freezing the page.
- A new Spend page shows the last 30 days by day, split by agent or feature, with a Download CSV button. The Runs, Workflow report and Features pages get their own Download CSV buttons too.
- Company export and import now carry your deploy targets, your own permission rules, approvals, templates and the second-opinion setup. A one-time step: after importing, re-grant the secrets and re-add any Allow rules, and switch the second opinion back on (adding its key secret if it is missing).
- Roadmap: you can change or remove a key result, and the Setup checklist now ends at "First ticket merged", showing how long it took from when you set up.
- The Wiki has a 30-day "Deleted pages" bin with Restore, and you can compare any two versions of a page side by side with added and removed lines marked.
- In the CEO chat, "Remember this" adds your own message to the standing rules, with an Undo.
- The website "What's new" page now shows the 21 November changes.
- Removing the portal logo or unlinking feedback asks you first, and so does removing an alert destination or a ticket's wait link. Switching a project back to the company's reviews asks before it deletes the project's own review table.
- Automatic daily database backups, keeping the newest 14 days, with the time of the latest shown in Settings → Server. Applying this update by hand once is needed (see its card), then it runs by itself.
- The check machines report their memory, and Settings warns if checks together would overcommit it. One-time step: redeploy each check machine once after you update the runners.

## 21 November 2026

**In image 0.1.0-beta.1**

- Pages that are still loading now say "Loading…", and a page that fails to load says so, instead of showing a blank space. This covers the public portal, the Roadmap, the Wiki, the Agents list, Settings → Watchdog and Settings → Funding.
- A paused company now has a Resume button.
- Stopping one run from a ticket or the Run page asks you first, and can't be sent twice.
- Removing a deploy target that still has deploys asks you first, instead of quietly wiping its history.
- On Permission rules, "Add rule" and "Ask the CEO to draft it" can no longer be clicked twice into two rules or two requests.
- Settings → Watchdog checks its limit numbers before saving, and says in plain words which box is wrong.
- The Dashboard's "Runner settings" link now opens the Runner page.
- Before an agent opens a new ticket, it now sees open and recently finished tickets with similar titles.
- Finished work that is waiting for its quick check now shows as "Being checked", not In progress.
- When two open tickets change the same files, both now show a warning.
- The short freeze that happened about once a minute is fixed.
- Container logs are now capped in size, so they can no longer slowly fill your server's disk.
- The Cloudflare tunnel and Tailscale add-ons now show "unhealthy" when their connection is down, instead of "running".
- A runner update now holds new work from the moment its build starts, and retries a failed swap once.
- More changes leave a line in the activity log: pausing or resuming a company, switching the watchdog, adding or removing a tool server or deploy target, turning the portal on or off, changing feedback settings, and turning Priority 1 on or off.
- A new website page, "What can go wrong with AI agent teams", tells 11 real failure stories and what Boss Man does about each.

## 20 November 2026

**In image 0.1.0-beta.1**

- A server update now says what it is waiting on and when it is running late, and your CEO chat keeps answering while it waits, instead of a bare "updating".
- An update you approve no longer waits for you to press anything else. Every wait along the way has its own end. A runner update still waiting after an hour goes ahead by itself and stops any agent runs still going. A server update still waiting for a quiet machine after an hour goes ahead too, unless memory really is short: then it gives up, tells you and tells your CEO.
- "Ask agents to wrap up" now belongs to the update it was pressed for and lifts by itself when that update goes in. With no update waiting, it lifts after an hour.
- On the Merge queue, each running merge check says where it runs ("on this server" or "on the check worker …"). A finished check shows its time per stage and whether it was quick or full, and the Quick checks tab explains what a busy slot means.
- The Decisions page rolls "Left your list recently" cards up to a few lines, with Show more.
- A Board search that matches nothing now says so, with a Clear search button.
- Errors now read as a plain sentence, not codes like "internal_error". A date that does not exist, such as 30 February, gets "Use YYYY-MM-DD." instead of a server error.
- The Dashboard, Features, Chat and ticket pages and the GitHub watcher settings show a loader, and an error with Retry, instead of a blank space.
- Create and Save buttons can no longer be clicked twice.
- Settings has one Save per section, and Save buttons only light up when there is something to save.
- Permission rules name the agent a rule is for, and saved credentials name the deploy target a secret is limited to.
- With no company yet, every page links to "Create your first company".
- Support can now reply to and close GitHub issues and discussions from inside Boss Man. One-time step: give your saved GitHub token "Read and write" for Issues and Discussions.
- Dependabot and secret-scanning alerts on a repo the GitHub watcher follows now come into Boss Man, and the security reviewer can read and close them there.
- Dependabot alerts open one ticket per package, not one per alert, and a new alert for that package joins its ticket. Each repo's alerts go to one project only, and a first sync that finds many alerts opens one summary ticket for your CEO.
- Settings → Email: Turn off now asks before it deletes the mail server details and password.
- The next ticket for a busy agent stays in Ready as "Next up" until its run starts.
- Merged tickets no longer sit in "Merged, watching" for ever after go-live, and never count against your limits.
- Moving a ticket that is already in review back to review asks the reviewers who asked for changes to look again.
- The website now serves its search-engine key file after a publish, and tells Bing and other search engines which pages changed each time it is published. If that notice keeps failing, the publish says so plainly so your CEO hears about it instead of it being lost.
- A ticket's activity feed shows its newest runs. Changing who reviews, and adding, editing or removing a permission rule, each leave a line in the activity log.
- In the CEO chat, a reply can add up to 2 short lines saying where you already answered a point it names.
- The workflow report opens with a "What this shows" card of up to three plain findings, and its column definitions fold behind "What the columns mean".
- The website now serves its search-engine key file after a publish, and tells Bing and other search engines which pages changed each time it is published. If that notice keeps failing, it now reaches your CEO as a ticket instead of being lost.

## 19 November 2026

**In image 0.1.0-beta.1**

- The runs history (for the CEO and Data & Analytics) now shows cached read and write tokens and a cost for each run, so a ticket's spend can be checked by token type.
- A finished change that waits behind another change's landing turn now learns early whether it still fits: if main has moved under it, it is rebuilt and checked again during the wait rather than up to an hour later, and if it clashes it goes back to its author at once. Fewer changes sit waiting only to be sent back.
- Owner cards with steps now have a "Why:", an "If you skip it:" and a Boss Man-written "Where" line.
- A go-live card must now state an undo and where it came from, and is refused until the change's preview checks pass with page proof.
- A card you have to apply by hand now shows its steps on the card before you click Approve.
- A card that only you can answer is no longer withdrawn as stale when its ticket closes unanswered.
- Boss Man won't ask you something its own record already answers, and your earlier answers about a setting now sit next to that setting.
- An override on a card check now names the steps and rules it covers, and a step you have already done is checked against what is really live.
- The Merge queue page is clearer: the badge and tab counts always agree, the "Merges" tab holds only merges, and "Quick checks" replaces "Queued checks".
- The merge line and its banner now name who holds the landing turn and when it ends, show a "paused" state with its reason, and warn when the line has grown for an hour.
- Fewer false alarms: the watchdog no longer flags work that is really waiting on a check, GitHub run or merge.
- After a ticket merges, its assignee can still update the state note, and a queued wake moves a parked Backlog task to In progress.
- Setup and in-app hints now match the current Settings paths and setup wizard.

## 17 November 2026

**In image 0.1.0-beta.1**

- Settings → Server and runner → Updates now says a runner update is "needed" or "not needed", never "may be needed".
- A go-live setup card opens with a short "Why:" line and an "If you skip it:" line, so you can see what a step buys you before you do it.
- Fewer cards with the wrong walk-through: a card's menu path ("Settings → …") must point at a real screen, or Boss Man refuses it.
- On a short window, the Settings side list folds the other groups to one row each, so the page you are on stays in view.
- The Plan page header takes less room on a touch screen, so the chart and button are easier to reach.
- Approved work that is held behind a fix now lets go by itself once that fix is live, and a removed hold no longer needs a hand release.
- The Go-live line no longer says "not live" for a change a later update carried, and the "Waiting for …" refusal on Build and update runners clears itself.
- Fewer stale cards: agents can now withdraw their own out-of-date cards.

## 16 November 2026

**In image 0.1.0-beta.1**

- A new "Priority 1" switch on tasks and features. It shows on the board, moves the work up the merge line, and tells you once when the work is ready to go live.
- The limits screens now show the value you saved and the value in force, with the reason and when the lower value lifts. For example: "Saved 16, in force 3" while an update runs.
- You can choose which kinds of check each check machine takes, and how many of its slots it keeps for merges. A check that is waiting says why.
- The runner update banner names what it is really waiting for and offers "Stop the checks and update now". Runner add-ons are now tick boxes.
- Budgets show your subscription use next to your pay-as-you-go spending, and the Plan page header takes far less room.
- Portal and phone links use your public address, not whichever address your browser happened to use. You no longer get repeat cards for questions you have already answered.
- A reviewer's approval is tied to the exact code they read, so a later change can't slip in under it.
- Merges can wait for GitHub's test results, and a failing change goes back to its author. Off by default: turn it on in Settings → Limits and checks → Checks after you update the runners.

## 15 November 2026

**In image 0.1.0-beta.1**

- A new Dashboard. It opens with "Needs you" (your waiting cards and sign-offs) and a live "Right now" strip, and shows a banner when merges are stuck.
- Simpler menus. The main menu is in three groups, with Settings and Log out at the bottom. "Server and runner" settings are split into six short pages, and the Reviews and Watchdog settings open with simple presets.
- A task that is only waiting now says so plainly on the board and the task page, for example "approved, waiting to merge", so it doesn't look stuck.
- Each project can have a monthly spending limit, and the money figures say more clearly what they count.
- A "Create phone login" button on the Notifications page sets up phone notifications. You can say which phone you use, and only its steps are shown.
- The Updates panel is one clear status box, and the Features page's "On portal" tick shows whether a feature really appears on your public page.
- Far fewer permission cards for clearing temporary files and running scratch scripts.
- New switches, all off by default: hold new work while merges are backed up; send new GitHub issues and comments to your feedback inbox; ask feedback-portal visitors to confirm their posts by email.

## 14 November 2026

**In image 0.1.0-beta.1**

- Every agent chat has a "Thinking" trace. Open a reply to see what the agent read, ran and decided, while it works and after a reload.
- Calmer screens: shorter board cards, one "Details" section on each task page with help behind "?" buttons, one-sentence page intros, and notifications filtered by one row of chips.
- Board filters sit behind one "Filter" button, with chips you can remove, and a panel from the bottom of the screen on phones.
- You can set up outgoing email in Settings, with a "Send test email" button. Off until you set it up.
- Fewer interruptions. Agents take routine questions to the CEO agent first, and when an account reaches its usage limit you get one card, not one per agent.
- Each task shows its build result from your git host, and the Funding bars go back to 0% after a usage reset.
- A merge train option lands approved changes in order, each checked on top of the ones ahead of it. Off by default.
- "Build and update runners" works again. It had been failing at the last step.

## 13 November 2026

**In image 0.1.0-beta.1**

- You can reorder the merge line: "Move to front" on the Merge queue page picks which change goes next, and urgent tasks go ahead of ordinary ones.
- The Merge queue page shows what is really running. It no longer shows more busy slots than there are, or lists waiting merges as running.
- "Ask agents to wrap up" now reaches Claude and Codex agents in the middle of a long step, after you update the runners.
- Changes can be scanned for keys, passwords and your own private details before they merge. Fill in Settings → "Private details to block" and update the runners to turn it on.
- Fewer false alarms after a restart: a server restart no longer restarts every approved merge at once, and you get fewer "Run the check again" cards.
- A withdrawn card says why and what replaces it, and a phone notification that fails says what went wrong.

## 12 November 2026

**In image 0.1.0-beta.1**

- Decision cards are redesigned. The recommended answer is on the first screen, each button says what it does, and sign-off cards list what you are approving.
- The Merge queue page puts what needs you first, has one "main is failing" banner, and shows counts on its tabs.
- You can press "Build and update runners" while a server update is still on trial. It waits, starts by itself, and you can cancel it. Deploy cards can offer "Deploy, then update runners".
- Approved work stays approved while it waits behind a stuck merge check. It shows as "Passed, held", with what it is waiting for.
- Agents you chat with have their full working tools, such as the design tool, and ask permission just as they do on tasks.
- Tidier Agents and Features pages: each agent row has one Pause button, a status label and a "⋯" menu, and the Features page is a plain list you edit in place.

## 11 November 2026

**In image 0.1.0-beta.1**

- "Answer in Decisions" opens the exact card, and a ticket page lists the cards that are blocking it.
- The Blocked column takes every kind of wait (your plan approval, a date, or a check after merge), and waiting tickets no longer count towards the in-progress limit.
- A new "Queued checks" tab on the Merge queue page shows each check's place in line and how long it has waited.
- Notes show their age, can carry a review-by date, and are marked "review due" when it passes.
- A missing page shows a plain "not found" message with a way back, empty dashboard charts say so, and the Wiki opens on the company brief.

## 10 November 2026

**In image 0.1.0-beta.1**

- Settings is one menu of 9 pages in 3 groups, on a computer and on a phone. Old links still work.
- You can limit how many tickets each agent works on at once (2 by default), with an optional limit for the whole company.
- By default your phone gets only urgent items. A "Recent phone pushes" list shows why each one arrived.
- New companies have the agent safety fence on by default, and each existing company gets one card asking you to choose.
- Alerts that an agent looks stuck go to the team's managers first, and reach you only if they pass it up.
- The merge queue names the card that is holding up a signed-off merge, with a link.
- Boss Man asks you before more kinds of risky delete command run.

## 9 November 2026

**In image 0.1.0-beta.1**

- Approve simple agent questions from a button in the phone notification. Each button works once and expires after 15 minutes, and Settings → Notifications can turn it off. It needs a private notification server on https.
- "Stop all work" pauses everything until you resume it, and a button on the Runs page ends every run in progress. An optional time limit per company ends long runs (off by default).
- Every text box keeps a draft as you type. If someone else changed a ticket while you were editing it, your text is kept so you can compare.
- Scrolling with the mouse wheel works anywhere over the board, the Decisions badge counts only cards you can act on, and old update cards fold to one line.
- The Features page and the public feedback portal were reworked. Each feature has an "On portal" tick, and visitors see only public titles and summaries.
- The forecast of when a subscription runs out uses the whole week, stopped services are named in plain words, and each merged ticket shows whether it is live on your server yet.

## 8 November 2026

**In image 0.1.0-beta.1**

- Permission cards can offer "Always allow", which saves a narrow rule so the same routine request stops coming back. It is never offered for risky actions, and you can undo it in Settings.
- A "Restart the server" button in Settings restarts Boss Man at a quiet moment.
- The board's Review area is split into "Awaiting review", "Approved, merging" and "Your review", and the side menu can shrink to a strip of icons.
- Fewer setup cards: changes that need the same step share one card, and a card Boss Man closes itself says why. Decisions lists the cards it closed in the last 30 days.
- Approved updates no longer fail when newer work lands first, and a sign-off card is withdrawn if the code changes after it was raised.

## 7 November 2026

**In image 0.1.0-beta.1**

- Boss Man no longer freezes for seconds at a time, uses much less memory, and the usage pages stay responsive.
- The Decisions queue shows your cards in the order to deal with them. High-risk work that needs your sign-off always gets a card.
- "Approve and merge" responds at once and finishes the merge in the background.
- Fewer permission cards reach you, because routine ones go to the lead agent first. The ones that do reach you say what they are for and what saying no would stop.
- After a restart or an update, the team gets back to work by itself.
- The board's Done column is no longer cut off, and the ticket page and side menu work on narrow screens such as folding phones.

## 6 November 2026

**In image 0.1.0-beta.1**

- Your messages on a ticket always get a reply. If no agent answers, Boss Man wakes it again, and after 10 minutes the CEO agent is asked to answer. The ticket shows whether your message was delivered.
- Wiki pages can't be wiped by accident. Every edit keeps a version you can restore, and an edit that would remove a large part of a page is refused.
- Work no longer stalls for hours when one Claude account is full: runs move to the next account with room.
- The Dashboard and the runs list load almost at once on large boards. They used to take about half a minute.
- Message boxes take long pastes in full and offer to send very long text as a file. Images that are too big are shrunk, not refused.
- "Standing rules" in Settings: one block of instructions that every agent reads at the start of every run.
- A stalled review gives you real choices: take it over, hand it to another reviewer, send it back, or wait.

## 5 November 2026

**In image 0.1.0-beta.1**

- Your approval is tied to the exact code you approved. If nothing changed before it merges, you are not asked again. If it changed, the new card says what changed.
- "Approve and merge" approves and merges in one press. When work is held, the banner names the agent, the account and when the limit resets.
- Fewer stale cards: alerts clear themselves once the cause has gone, and repeated account failures become one card.
- A card that asks you to do something is checked first. Steps that only say "see the guide", or hold placeholders or commands that are not safe to copy, are refused before they reach you.
- If a change needs a setup step from you, its card arrives once the change is live, and is withdrawn if the update is rolled back.
- Cards and ticket pages show where a merge stands: queued, checking, or failed and why.

## 4 November 2026

**In image 0.1.0-beta.1**

- The Chat page fills the window, with the message box always in view at the bottom.
- Click a picture on a wiki page to enlarge it, with "Fit to window" and "Actual size".
- Urgent tickets go ahead of other work when every slot is busy.
- Choose who reviews what in one place, Settings → Reviews, with more than one reviewer for each kind of review.
- Decisions, Chat and the ticket page are easier to use on phones, with bigger buttons.
- Boss Man notices agents that have gone quiet, asks them for a status, and flags them if they stay silent.

## 3 November 2026

**In image 0.1.0-beta.1**

- List your Claude plans in order on the Funding page. When one reaches its limit, new work moves to the next plan with room, and you are told when it switches.
- Two identical permission requests close together now give you one card, not two.
- The Copy button on cards works on plain "http" addresses too. If copying fails, it selects the text for you.
- Permission cards use plain words instead of error codes, and no longer warn that an agent is offline after its run has ended.
- Changing a ticket's note while it is in review no longer restarts the review.
- The "Build and update runners" offer appears only after a server update has passed its 15-minute trial.

## 2 November 2026

**In image 0.1.0-beta.1**

- You can reach Boss Man at a secure (HTTPS) address on your private Tailscale network. Optional: you set it up yourself.
- Permission cards have an "Ask CEO for advice" option.
- Previews of attached files work again, and the wiki's page list folds away on small screens.
