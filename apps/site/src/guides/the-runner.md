---
title: "Your agents' workspace (the runner)"
description: What the runner is, why your agents work there and not on the rest of your machine, what "Not connected" and "Runner offline" mean and what to do, and how big a machine it needs.
group: Everyday use
order: 9
lead: The runner is the separate, locked-down workspace your agents work in. You start it once and it keeps running.
---

## In short

The runner is your agents' workspace. It is a sealed-off space on the machine that runs Boss Man, and each company has its own. Your agents read, write and test their work there, and nowhere else.

You start it once, in step 3 of the setup wizard. After that it keeps running, and it comes back by itself after a restart or an update.

If it stops, your agents cannot start new work. The home page says **Runner offline**, and after 3 minutes Boss Man tells you. Most of the time the fix is one button: see [If it says Not connected or Runner offline](#if-it-says-not-connected-or-runner-offline).

## Why agents work in a separate space

Agents run commands and install tools to do their work. The runner keeps that away from the rest of your machine and your home network:

- **It cannot reach your home network.** A network guard sits in front of each runner. It lets the runner reach the internet, the Boss Man server, your git host and any tool servers you added, and refuses every other address on your network, such as your router, your NAS or other computers. If agents really need one of those, you can allow it (see [Permissions](/guides/permissions#who-is-asked)).
- **It cannot control your machine.** It runs as an ordinary user with no special rights, and it cannot start or stop other programs on the machine.
- **It only sees its own company's files.** Each company's runner has its own folders. One company's agents cannot read another company's work.
- **It gets only the keys it needs.** Keys and tokens you save under **Settings → Secrets** are given to the agents that need them, not shown on any page.

If the network guard cannot start, Boss Man pauses the runner on purpose, with its work kept, rather than run it unguarded. The Updates page then shows **Paused: network guard**. Boss Man keeps trying, and the runner carries on by itself once the guard works.

## Where to see it

- **The home page** shows one line for the runner: **Runner connected** when all is well.
- **Settings → Server and runner → Runner** shows its state and has its buttons.
- **The setup wizard, step 3**, shows **Connected** or **Not connected**.

## If it says Not connected or Runner offline

**Not connected** (in the setup wizard) and **Runner offline** (on the home page) mean the same thing: the runner is not talking to Boss Man, so no agent can start work. Runs and checks already waiting stay in line. Nothing is lost.

1. In the setup wizard, choose **Start the runner**. The page says "Starting the runner" and updates when it connects. This can take up to a minute.
2. Anywhere else, open **Settings → Server and runner → Runner**. Choose **Start runner** if it is stopped, or **Reconnect runner** if it is not. Reconnect gives the runner a new container, and work in progress carries on from where it stopped.
3. Wait for it to say **Connected**.

Do not use **Update runners** for this. That builds a new version of the runner, which takes longer and does not fix a stopped one.

If the wizard lists a problem under **Not connected**, each problem has a **How to fix it** link. If it still will not connect, follow [The runner says Offline](/guides/troubleshooting#the-runner-says-offline-or-not-started-or-never-says-connected) in Troubleshooting, or tell the CEO in chat what the page says.

**What Boss Man tells you.** When a runner has been offline for 3 minutes, you get an alert such as "Acme's runner is offline", with the steps above (it goes to your phone too if you set that up). When it comes back, you get "Acme's runner is back", and nothing more is needed.

## It keeps running by itself

- **After your machine restarts**, Docker starts the runner again when it starts. You do not press anything.
- **After a server update**, the runner keeps running and reconnects to the new server by itself.
- **After a runner update**, Boss Man swaps each company's runner for the new one when that company has nothing running. See [How updates work](/guides/how-updates-work).
- **If a run is cut off** because the runner restarted, the agent's next run is told and picks up from the steps it had already finished. A check that was cut off goes back in line and runs again.

## How big a machine it needs

Plan on 16 GB of memory for one company with the default settings, or 8 GB with one agent at a time. Each runner gets 2 GB, plus 1 GB for each agent that may run at once, plus 3 GB for each check. The full table is in [What machine do I need](/guides/install-boss-man#what-machine-do-i-need).

The setup wizard's runner step, and **Settings → Server and runner → Limits and checks**, show a memory line such as "This machine can run 6 agents at once, or 3 agents plus 1 check." If it suggests lowering **Agents at once**, do that, so agents and checks do not run out of memory.

## Related

- [How updates work](/guides/how-updates-work): what happens to the runner during an update.
- [Checks and check workers](/guides/checks-and-check-workers): what a check is, and running checks on another machine.
- [Stopping work](/guides/stopping-work): pause agents, or stop everything at once.
