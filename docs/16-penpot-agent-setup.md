# Penpot: let agents read your designs (owner steps)

You do this once, after Penpot is running (see [15-penpot.md](15-penpot.md)). No coding. Agents get read-only access to what the agent account can see, and nothing else.

1. **Make the agent account.** Open Penpot in your browser (`http://<your server's address>:9001`). Registration is normally closed; the install notes in 15-penpot.md say how to open it briefly. Register a new account for the agents, for example `agents@penpot.local`, with a long random password you keep in your password manager.
2. **Share only what agents may see.** Log in as yourself, open the team, and invite the agent account as **Viewer** to the team or project you want agents to read. Viewer cannot change anything.
3. **Make the access token.** Log in as the agent account. Click its name (bottom left) > **Your account** > **Access tokens** > **Generate new token**. Name it `boss-man`, choose an expiry (90 days is a good start; put the renewal date in your calendar), and create it. Copy the token now: Penpot shows it only once.
4. **Save it in Boss Man.** Go to the Secrets screen and add a secret named `PENPOT_TOKEN`; paste the token as its value. Add a second secret named `PENPOT_URL` with Penpot's address, for example `http://192.168.1.20:9001` (use the same address the runners can reach). Never paste the token into a ticket, chat or file.
   **For PNG export only:** Penpot's export service cannot use an access token; it needs a login. Add two more secrets, `PENPOT_EMAIL` (the agent account's email) and `PENPOT_PASSWORD` (its password), and grant them in the next step too. Without them everything else works but `export` says what is missing.
5. **Grant it to named agents only.** On each secret, grant `PENPOT_TOKEN`, `PENPOT_URL`, `PENPOT_EMAIL` and `PENPOT_PASSWORD` as environment variables with those same names, to the agents who need designs (for example the Designer and the Developer), and nobody else. Grant `PENPOT_EMAIL` and `PENPOT_PASSWORD` only to the agents that actually export boards, not to everyone who holds the token.
6. **Give them the skill.** In Skills, add the `penpot` skill (paste this link: https://github.com/Leonfinn/Boss_Man/tree/main/skills/penpot), then give it to the same agents.
7. **Try it.** Make a ticket for one of those agents: "List the files in Penpot and attach a PNG of the first board." If the agent says it isn't set up, check steps 4 and 5. If export fails, check that the email and password secrets are right.

**When the token expires or leaks:** in Penpot, delete the token under Your account > Access tokens, make a new one, and replace the secret's value in Boss Man.

**If `PENPOT_PASSWORD` leaks:** in Penpot, signed in as the agent account, change its password (Your account > Password), then replace the secret's value in Boss Man. The password must be unique to that account and used nowhere else. Keep the account Viewer-only: unlike a token, a password gives control of the whole account.
