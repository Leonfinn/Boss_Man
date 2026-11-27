---
title: "Connect a Claude account: plan or API key?"
description: Choose between a Claude Pro or Max plan and an Anthropic API key for your agents, then connect it step by step, on a Mac or Windows, with no terminal experience needed.
group: Start here
order: 3
lead: Your agents are Claude. They need a Claude account to run on, and that account is what you pay for their work. There are two kinds. This page helps you pick one and connect it.
---

## Which one to choose

| | Claude plan (Pro, Max or Ultra) | API key (pay as you go) |
|---|---|---|
| What you pay | A fixed monthly price. Pro is $20 a month, billed monthly. Max and Ultra cost more and give more use. | Only what your agents use. You buy credit in advance. |
| Limits | A usage allowance that resets every 5 hours and every week. When it runs low, Boss Man pauses routine work until it resets. | No allowance. Work runs until your credit or your monthly spend limit runs out. |
| Setting it up | Install Claude Code on your own computer and type one command. You do this once a year. | Everything happens in your web browser. |
| Suits | Steady, everyday use, where a fixed bill matters more than speed. | Trying Boss Man out, light use, or when you would rather not use a terminal. |

Prices are from [claude.com/pricing](https://claude.com/pricing), confirmed on 27 November 2026. They can change, so check there before you buy.

Not sure? Start with whichever account you already have. You can add the other one later under **Settings → Secrets**, and Boss Man can use both.

## Connect an API key

You need a Claude Console account, which is separate from a claude.ai chat account. Steps confirmed against Anthropic's own help pages on 27 November 2026. They have not yet been walked through in a signed-in Console for this guide.

### 1. Sign in to the Claude Console

Open [platform.claude.com](https://platform.claude.com/) and sign in, or create an account.

### 2. Buy credit

Open **Billing** ([platform.claude.com/settings/billing](https://platform.claude.com/settings/billing)) and choose **Buy credits**. Enter an amount and confirm. API use is paid from this credit. When it runs out, your agents stop until you add more.

### 3. Set a monthly spend limit

Open **Spend limits** ([platform.claude.com/settings/spend-limits](https://platform.claude.com/settings/spend-limits)). Next to **Monthly spend limit**, choose **Set limit**, enter the most you want to spend in a calendar month, and save. Once your agents reach it, Anthropic refuses their work until the next month or until you raise it.

### 4. Create the key

Open **API keys** ([platform.claude.com/settings/keys](https://platform.claude.com/settings/keys)) and choose **Create key**. Give it a name such as "Boss Man", and choose when it expires. Anthropic shows the whole key once only, so copy it now. It starts with `sk-ant-`.

### 5. Paste it into Boss Man

In the setup wizard's **Claude** step, open **Use an API key instead**. Under **Add**, choose **Anthropic API key**. Paste the key into **Value** and choose **Save**. Leave the other boxes as they are.

Then, in the wizard's **What pays for the CEO** step, add a funding source. Name it, for example "Anthropic API". For **Kind**, choose **API, pay as you go**, and for **Provider**, choose **Anthropic**. Choose **Add funding source**, then pick it under "The CEO runs on". The funding source is how Boss Man tracks what your agents spend: see [What agents cost](/guides/what-agents-cost).

:::worked
Under **Settings → Secrets** the key is listed for your company. Choose **Check** beside it to try it.
:::

## Connect a Claude plan with a setup token

A setup token is a code that links your Claude plan to Boss Man. You make it on your own computer, a Mac or a Windows PC, not on the machine that runs Boss Man. It works with a Pro, Max, Ultra, Team or Enterprise plan, and it lasts one year.

You type two commands into a terminal. A terminal is a window where you type a command and press Enter. Claude Code needs macOS 13 or newer, or Windows 10 (version 1809) or newer.

### 1. Open a terminal

- **Mac.** Press Command and Space, type `Terminal`, and press Enter.
- **Windows.** Press the Windows key, type `PowerShell`, and press Enter. You do not need to run it as an administrator.

### 2. Install Claude Code

Copy the line for your computer, paste it into the terminal, and press Enter. To paste, press Command and V on a Mac, or right-click in PowerShell.

```sh Mac: paste into Terminal
curl -fsSL https://claude.ai/install.sh | bash
```

```powershell Windows: paste into PowerShell
irm https://claude.ai/install.ps1 | iex
```

These are Anthropic's own install commands, from [Claude Code's setup page](https://code.claude.com/docs/en/setup), confirmed on 27 November 2026. Wait until it finishes and the terminal is ready for the next command.

### 3. Make the token

Close the terminal window and open a new one, as in step 1. Then type:

```sh Mac or Windows
claude setup-token
```

Your web browser opens. Sign in with the claude.ai account that has your plan, and approve access. Go back to the terminal: it now shows a long token that starts with `sk-ant-oat01-`. Copy all of it. The terminal shows it only once and does not save it.

This is how Anthropic's [authentication page](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) describes the command, as of 27 November 2026. Not yet confirmed by running it for this guide: what the terminal shows may look slightly different.

### 4. Paste it into Boss Man

In the setup wizard's **Claude** step, paste the token into **Claude setup token** and choose **Save the token**. This also sets up what pays for the CEO, so the wizard's **What pays for the CEO** step is already done.

:::worked
The Claude step shows **Connected**, and names the saved token.
:::

A year later, the token stops working. Run step 3 again and save the new token under **Settings → Secrets**.

## Keep the key or token safe

Paste it only into Boss Man's forms. Never put one in a chat, a task or the wiki, because agents can read those. Boss Man stores it encrypted and never shows it again.

## If something goes wrong

- **"Expected the value to start with "sk-ant-oat01-"."** What you pasted is not a setup token. Copy the whole token the command printed, from `sk-ant-oat01-` to the end, and paste it again. Do not paste an API key here: it goes under **Use an API key instead**.
- **"Expected the value to start with "sk-ant-api"."** What you pasted is not an API key. Go back to the Console's **API keys** page. If you no longer have the key, create a new one: the Console never shows a key again.
- **`claude: command not found`, or "not recognized" on Windows.** The terminal was opened before Claude Code was installed. Close it, open a new one, and run `claude setup-token` again. If that still fails, run the install command from step 2 again.
- **The key is saved but agents' work is refused.** Your Console credit has run out, or you reached your monthly spend limit. Check **Billing** and **Spend limits** in the Console.
- **The token worked, then stopped.** It is more than a year old, or you changed your plan. Make a new one (step 3) and save it under **Settings → Secrets**.

## Related

- [What agents cost](/guides/what-agents-cost): funding sources, limits, and where to see spend.
- [Agents and models](/guides/agents-and-models): other AI accounts, several Claude plans, and choosing a model.
- [Your first company and task](/guides/first-company-and-ticket): the rest of the setup wizard.
