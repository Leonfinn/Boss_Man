---
title: Stopping work
description: Pause one agent, pause a company, stop all work, ask agents to wrap up, or end the runs going now, and which one to use when.
group: Everyday use
order: 12
lead: Boss Man has several ways to stop work. Most of them only stop new work from starting and let running agents finish. Two of them end running work now, and anything an agent has not saved is lost.
---

This guide is for you if you want to stop an agent, or every agent, for example before an update or because one agent is doing the wrong thing.

## Which one do I need?

| Situation | Use | What happens to work already running | How to undo it |
|---|---|---|---|
| One agent should not start anything new | **Pause** on the **Agents** page | Finishes by itself | **Start** on the same row |
| One company should not start anything new | **Pause company** in **Settings > Team and CEO** | Finishes by itself | **Resume company** |
| Nothing should start anywhere, for as long as you say | **Stop all work** in **Settings > Server and runner > Updates** | Finishes by itself | **Resume** on the banner at the top of every page |
| You want agents to save their work and stop soon, for example before an update | **Ask agents to wrap up** in **Settings > Server and runner > Updates** | Each agent is asked to save and stop | **Cancel wrap-up**, or wait: it lifts by itself |
| One run is doing the wrong thing now | **Stop** on the ticket page, or **Stop run** on the run's page, then confirm | That run ends now. Unsaved work is lost | Nothing to undo. The ticket waits where it stopped |
| Everything must stop now | **End all running runs** on the **Runs** page | Every run ends now. Unsaved work is lost | Nothing to undo |

Ending a run does not stop new ones from starting. To stop everything and keep it stopped, use **Stop all work** first, then end the runs.

## Pause one agent

Open **Agents** in the sidebar. On the agent's row, choose **Pause**.

The agent starts nothing new. Work that would wake it waits in line. A run it already has going is not cut off: it finishes by itself.

To undo it, choose **Start** on the same row. Its waiting work starts straight away.

**Check it worked:** the agent's row shows an amber **Paused** tag, and the button now says **Start**.

## Pause one company

Open **Settings > Team and CEO** and find **Pause this company**. Choose **Pause company**.

No agent in that company starts a new run. Runs already going finish by themselves. Other companies keep working.

To undo it, choose **Resume company** in the same place.

**Check it worked:** the section says "This company is paused: nothing new starts until you resume it", and the company shows **Paused** in the sidebar.

## Stop all work

Open **Settings > Server and runner > Updates** and find **Stop all work**. Choose **Stop all work**, then confirm.

No new agent run starts in any company until you resume. Runs already going are not cut off: they finish by themselves. Wake-ups and messages wait in line, and start when you resume. The hold stays on after a server restart or an update.

To undo it, choose **Resume** on the banner at the top of any page.

**Check it worked:** every page shows a banner that starts "All work is stopped", with a **Resume** button. In **Stop all work**, a red **On** tag says "All work is stopped".

## Ask agents to wrap up

Open **Settings > Server and runner > Updates**. Under **Other actions**, choose **Ask agents to wrap up**.

Every running agent gets a message asking it to finish the step it is on, save its work on its ticket, write down the next step, and stop. Nothing new starts while the wrap-up is on.

It does not stop an agent at once. Some agents can only read the message when their current step ends, and a long step such as a check can take 15 minutes or more.

Under the status box, a list shows each agent still running, its ticket, and how long ago it was asked:

- **Finishing up**: it has the message and is saving its work.
- **In a long step: it will stop when this step ends**: it will read the message when the step finishes.
- **Waiting for an answer**: it is waiting for an answer on a card before it can stop.
- **Still going after 30 min** (in red): it has not stopped 30 minutes after being asked. Boss Man never stops it by itself. Choose **Stop this run** to end it now. Anything it has not saved is lost.

The wrap-up lifts by itself. If it was for a server update, it lifts when that update is no longer waiting. If no update was waiting, it lifts after 60 minutes. A runner update you start takes it over. To lift it sooner, choose **Cancel wrap-up**. Agents that ended cleanly are woken again on their tickets.

You only see **Ask agents to wrap up** if the optional host deployer is set up (see [Update from the web page](/guides/updates-and-backups#update-from-the-web-page-optional)). Without it, use **Stop all work** and wait for the **Runs** page to show no runs.

**Check it worked:** a banner at the top of every page says agents were asked to wrap up, and how many runs it is waiting for. When the list under the status box is empty, every agent has stopped.

## Stop one run

On the ticket page, while an agent is working on the ticket, choose the red **Stop** button next to **Interrupt and send**. Or open the run from **Runs** and choose **Stop run**. Then confirm: Boss Man first asks whether to stop the agent's run, and warns that it stops mid-step, so anything not yet committed can be lost. Choose **Cancel** and the run carries on.

The run ends where it is. Anything the agent has not saved is lost. Commits it already made are kept. The agent is not woken again for that run: its ticket waits where it stopped.

Stopping a run does not pause the agent. If something wakes it again, it starts a new run. To stop that, pause the agent too.

**Check it worked:** the page says "Stopping the run.", and within a minute the run moves from **Running now** to the finished runs on the **Runs** page. If the runner is offline, the page says Boss Man marked the run as stopped.

## End all running runs

Open **Runs** in the sidebar. Under **Running now**, choose **End all running runs**, then confirm. Only you, the owner, see this button, and only while something is running.

Every run going now, in every company, ends at once. Work the agents have not saved is lost. Commits they already made are kept. If one run cannot be ended, Boss Man carries on with the rest.

It does not stop new runs from starting. Use **Stop all work** first if you want nothing to start again.

**Check it worked:** a line next to the button says how many runs ended, for example "Ended 3 runs." If it says some "could not be ended", open each run still listed under **Running now**, choose **Stop run** and confirm.

## Example: before a server update

You want to update Boss Man, and three agents are working.

**With the host deployer** (you update from the web page):

1. Open **Settings > Server and runner > Updates** and choose **Review and deploy**, then **Deploy** on the card that opens in **Decisions**. Back in **Updates**, the status box shows **Approved, waiting**: "Your update is approved and waiting for a quiet machine."
2. Choose **Ask agents to wrap up**. The banner says agents were asked to wrap up.
3. Wait for the list of running agents to empty. If an agent shows **Still going after 30 min**, choose **Stop this run** on its row and confirm.
4. The update goes in by itself once the machine is quiet. The wrap-up then lifts by itself and new work starts again. There is nothing to press.

**With `scripts/deploy.sh`** (no host deployer):

1. Open **Settings > Server and runner > Updates** and choose **Stop all work**.
2. Open **Runs** and wait until **Running now** says "No agents are running". To end a run sooner, open it, choose **Stop run** and confirm.
3. Run `scripts/deploy.sh` on the machine, as [Updating and backups](/guides/updates-and-backups#update-the-server) explains, and wait for it to report healthy.
4. Choose **Resume** on the banner at the top of the page.

## Example: one agent is doing the wrong thing

An agent called Moss keeps changing the wrong files on a ticket.

1. Open the ticket and choose the red **Stop** button, then confirm. Moss's run ends. Anything Moss had not saved is lost.
2. Open **Agents** and choose **Pause** on Moss's row, so Moss does not start again on this or another ticket.
3. Write on the ticket what Moss should do differently, or move the ticket back.
4. When you are ready, choose **Start** on Moss's row.

## If something goes wrong

### I chose Stop all work, but an agent is still working.

That is expected. **Stop all work** lets running agents finish. To end a run now, use **Stop** on its ticket page or **End all running runs** on the **Runs** page.

### Nothing starts, and I do not know why.

Check, in this order:

1. The top of the page: a banner shows if all work is stopped, agents were asked to wrap up, or an update is pending.
2. **Settings > Team and CEO**: the company may be paused.
3. **Agents**: the agent may be paused.

Related: [Updating and backups](/guides/updates-and-backups), [Troubleshooting](/guides/troubleshooting).
