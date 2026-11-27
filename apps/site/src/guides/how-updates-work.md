---
title: How updates work
description: What an update changes, whether your agents' work stops, what you press on an image install and on a build-from-source install, and what to do if an update fails.
group: Everyday use
order: 10
lead: An update is a new version of Boss Man itself, installed by Boss Man when you say so. Nothing updates without you, and a failed update goes back to the version you had.
---

## In short

- **Nothing updates by itself.** Boss Man tells you a new version is ready, and you choose when to take it.
- **Your data is safe.** Boss Man backs up its database before every update of the server.
- **Work pauses briefly, not for long.** Running work is allowed to finish. New work waits a few minutes and then carries on.
- **A failed update goes back by itself** on the image install and on a blue/green install, so you keep the version that worked.

What you press depends on how you installed Boss Man. If you used the ready-made images, see [On an image install](#on-an-image-install). If you built it from the source code, see [On a build-from-source install](#on-a-build-from-source-install).

## What an update changes

Boss Man has two parts that update:

- **The server**: the web pages you use, and the part that plans and records the work. Your companies, tasks, wiki and settings are kept.
- **The runners**: [your agents' workspaces](/guides/the-runner). A runner update brings new tools for agents, such as a newer Claude Code. It does not touch your data.

## Does work stop?

**Server update.** On the image install and on a blue/green install, the new version starts beside the old one, and the pages keep working while it goes in (about 5 minutes). Then comes a **15-minute trial**: Boss Man watches the new version and switches back to the old one by itself if anything fails. On a single-server install, Boss Man is unreachable for a minute or two while it restarts. Runners keep running, and reconnect by themselves.

**Runner update.** Agents that are working are allowed to finish. New runs and checks wait until the runners have been swapped. Boss Man swaps each company's runner as soon as that company has nothing running.

- When a runner update follows a server update, Boss Man asks agents to finish up by itself, 10 minutes before the server's trial ends. A banner says so and ends with "Nothing for you to press."
- To make it quicker, choose **Ask agents to wrap up** (see [Stopping work](/guides/stopping-work#ask-agents-to-wrap-up)).
- If work is still going after 30 minutes, a card asks what to do. **Swap as soon as these finish** is the usual answer. If nobody answers, new work starts again 90 minutes after the update began, and the swap still happens once each company is idle.

## On an image install

**Not yet confirmed.** The **Install** button below is written from the build that adds it, before it has been tried on a real image install.

Once a day, Boss Man checks whether a new release is out.

1. When one is, you get one notification: "Boss Man 0.2.0 is available" (with the new version's number). It goes to your phone too if you tick **Also send it to my phone**.
2. Open **Settings → Server and runner → Updates**. The line at the top names the new version and links its **Release notes**.
3. Choose **Install 0.2.0**. Boss Man backs up the database, starts the new version beside the old one and switches over. The line shows each step, such as "Backing up the database". You can leave the page; it may blink once when the new version takes over.
4. When it ends, the line says what happened: updated, or went back and why. Choose **Got it** to clear it.

If the line says "This server was made before the Install button existed", this one update has to be done by hand on the machine. Ask the CEO in chat for the steps for your install. The version that update brings has the button, so you do this only once.

On an image install, the runners update with the release: a working runner moves to the new version the next time it restarts. The **Build and update runners** button is for build-from-source installs and does not apply here.

## On a build-from-source install

**With the host deployer.** The host deployer is an optional helper on your machine that lets Boss Man update itself from the web page ([how to set it up](/guides/updates-and-backups#update-from-the-web-page-optional)). With it:

1. When new code is ready, a card on **Decisions** asks "Deploy Boss Man …?". Choose **Deploy**, or **Not now**. **Settings → Server and runner → Updates** shows the same offer as **Review and deploy**.
2. If the update also changes the runners, the card offers **Deploy, then update runners after the trial**. Choose it, and Boss Man does both, in order.
3. About once a week, update the runners for new Claude Code releases: on the Updates page, under **Other actions**, choose **Build and update runners**.

Some changes cannot be applied from the web page, such as changes to how Boss Man is installed. For those, the card lists the steps to run on the machine under **What you'll need to do**.

**Without the host deployer**, you update from the machine's command line with `scripts/deploy.sh` and `scripts/update-runner.sh`. The steps are in [Updating and backups](/guides/updates-and-backups).

## If an update fails

**Image install.** The new version goes back to the old one by itself if it fails during its trial. The line on the Updates page says it went back, and why. Your data is unchanged.

**Build-from-source with the host deployer.** The Updates page shows **Update failed** and says "Boss Man is still on the earlier version, so nothing is broken", with the reason. Choose **Try again** once. If it fails again, tell the CEO in chat and give them the reason the page shows.

**Single-server install by hand.** If the server does not come back healthy, `scripts/deploy.sh` does not undo anything by itself. It prints the commands to go back. `scripts/deploy.sh --rollback` puts the previous version back without touching your data. See [Updating and backups](/guides/updates-and-backups#update-the-server).

If a runner update fails its safety check, the runners keep the version they had.

## Related

- [Updating and backups](/guides/updates-and-backups): the command-line steps, and where backups are kept.
- [Stopping work](/guides/stopping-work): ask agents to wrap up before an update.
- [What's new](/whats-new): what each update brings.
