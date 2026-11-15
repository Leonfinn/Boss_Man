# Privacy: what Boss Man sends, and where

This page is for you if you want to know whether Boss Man reports on you or on how you use it.

**It does not.** Boss Man has no usage counts, crash reports, analytics or update checks. There is no Boss Man account and no hosted service, so there is nowhere for it to send them.

## What leaves your machine

Only what you set up yourself:

| Where it goes | What goes there | When |
|---|---|---|
| Your AI accounts (Claude, OpenAI, OpenRouter, Ollama Cloud or Synthetic) | Prompts, and the code and text your agents work on | Every agent run |
| Your git host (GitHub or Gitea) | Your project's code, with the token you made | When agents fetch and push |
| Your ntfy server | Your notifications | Only if you set up phone notifications |
| ntfy.sh | A wake-up with the message ID only, never its text | Only if you added `NTFY_UPSTREAM_BASE_URL` for an iPhone |
| Synthetic | A check of your remaining credit | Only if you use a Synthetic account |
| The service you name under **Semantic search** on the Wiki page | Wiki text and search words | Only if you tick **Search by meaning as well as words** |
| GitHub | A request for the skill's files | Only when you add a skill from a GitHub link |

## Things to know

- **The agent programs are made by others.** Claude Code, Codex and OpenCode talk to their own makers' services. Boss Man turns off Claude Code's non-essential traffic for every agent run. For the others, read their own documentation.
- **Agents can read web pages** while they work. What else they may run or reach is set by your permission rules (see Guide 6 on the website).
- **Installing and updating** downloads Docker images and software packages from their usual public sources, like any other download.

## Visitors to your feedback portal

If you tick **Confirm posts by email** (Feedback → Feedback portal), visitors give an email address, and Boss Man emails them one confirmation link through the outgoing email you set up.

- **Unconfirmed posts** are saved out of sight (not shown to you, your agents or other visitors, and not counted) and deleted when the link runs out (24 hours unless you change it).
- **The address** is kept on the post only until the visitor clicks the link. If they gave a name, the name and address then become a customer on the Feedback page; if not, the address is not kept at all.
- **Confirmed browsers** are remembered for 90 days (you can change it) by a cookie, and Boss Man stores only a one-way hash of the address and of the cookie's secret, never the address itself. Expired ones are deleted.
- **Other visitors** never see an address. Your agents see a customer's address only inside a block marked as coming from outside.

## How we checked

We searched Boss Man's server, web and runner code for every outside web address and for analytics tools, on 9 November 2026. This was a search of the code, not a watch of a running server's network traffic, and it does not cover what other people's software does on its own.

If you see Boss Man send something that is not on this page, please tell us. See [SECURITY.md](../SECURITY.md).
