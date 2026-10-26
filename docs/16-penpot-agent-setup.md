# Penpot: let agents read your designs (owner steps)

You do this once, after Penpot is running (see [15-penpot.md](15-penpot.md)). No coding. Agents get read-only access to what the agent account can see, and nothing else.

1. **Make the agent account.** Open Penpot in your browser (`http://<your server's address>:9001`). Registration is normally closed; the install notes in 15-penpot.md say how to open it briefly. Register a new account for the agents, for example `agents@penpot.local`, with a long random password you keep in your password manager.
2. **Share only what agents may see.** Log in as yourself, open the team, and invite the agent account as **Viewer** to the team or project you want agents to read. Viewer cannot change anything.
3. **Make the access token.** Log in as the agent account. Click its name (bottom left) > **Your account** > **Access tokens** > **Generate new token**. Name it `boss-man`, choose an expiry (90 days is a good start; put the renewal date in your calendar), and create it. Copy the token now: Penpot shows it only once.
4. **Save it in Boss Man.** Go to the Secrets screen and add a secret named `PENPOT_TOKEN`; paste the token as its value. Add a second secret named `PENPOT_URL` with Penpot's address, for example `http://192.168.1.20:9001` (use the same address the runners can reach). Never paste the token into a ticket, chat or file.
5. **Grant it to named agents only.** On each secret, grant both `PENPOT_TOKEN` and `PENPOT_URL` as environment variables with those same names, to the agents who need designs (for example the Designer and the Developer), and nobody else.
6. **Give them the skill.** In Skills, add the `penpot` skill (folder `skills/penpot` in the Boss Man repository), then give it to the same agents.
7. **Try it.** Make a ticket for one of those agents: "List the files in Penpot and attach a PNG of the first board." If the agent says it isn't set up, check steps 4 and 5. If it says export isn't confirmed, export the board by hand and attach it.

**When the token expires or leaks:** in Penpot, delete the token under Your account > Access tokens, make a new one, and replace the secret's value in Boss Man.
