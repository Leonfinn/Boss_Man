# Spike S2: ACP in a runner container

**Question:** can a headless Boss Man runner drive Claude Code and Codex over ACP? Specifically, can it:

- run several sessions at once;
- read model lists;
- answer `session/request_permission` by policy;
- pass Boss Man's MCP server through to the agent?

**Status (2026-10-16):** **passed with a stub model.** Every check below passed for both agents inside the runner container, which ran with no network access. A run against a **real model** is still to do, using your own credentials (see below).

## What was tested

`src/harness.ts` plays the role of the Boss Man runner daemon. It:

1. starts an ACP adapter (`claude-agent-acp` 0.91.0 or `codex-acp` 2.2.2) over stdio;
2. opens **3 sessions**, each with its own workspace and its own **per-session MCP token**;
3. prompts all 3 sessions at once.

`src/stub-anthropic.ts` is a scripted model server. It answers in the Anthropic Messages format for Claude and the OpenAI Responses format for Codex. Each scripted turn makes the agent:

- run `echo spike > spike.txt`, which the policy should **allow**;
- call `bossman.create_ticket` through MCP;
- run `rm -rf /srv/precious`, which the policy should **deny**.

`src/policy.ts` answers permission requests by rule. `src/mcp-server.ts` is a minimal Boss Man MCP server that records which session token made each call.

The stub tests the **plumbing** only. It says nothing about how a real model behaves.

## Results (inside the runner image, `--network none`)

| Check | Claude Code (via `claude-agent-acp`) | Codex (via `codex-acp`) |
|---|---|---|
| 3 concurrent sessions, one connection | ✅ ~1.5 s each | ✅ ~0.3 s each |
| Runs the **image's official binary** (R6) | ✅ every request's user-agent was `claude-cli/2.1.301`, the npm-installed Claude Code, not the SDK's bundled 2.1.300 | n/a (bundled `@openai/codex`) |
| Model list from ACP `configOptions` | ✅ **aliases**: `default, opus, fable, sonnet, haiku` (`default` resolved to `claude-opus-5-5`) | ✅ **8 concrete IDs**, e.g. `gpt-6.1-sol` … `gpt-5.5` |
| Unlisted model via `session/set_config_option` | ❌ rejected | ❌ rejected (`Invalid params`) |
| Unlisted model pinned at **launch** | ✅ `ANTHROPIC_DEFAULT_OPUS_MODEL=<id>` + select `opus` → requests used `<id>` | ✅ `CODEX_CONFIG={"model":"<id>"}` → `<id>` became current and was added to the list |
| Permission requests reach the client | ✅ `kind`, `title` and `rawInput` (the command) included | ✅ **only in `workspace-write` mode** (see findings) |
| Policy allow / deny works | ✅ allowed `echo`, denied `rm -rf`; the turn continues after a denial | ✅ allowed, denied; **a denial ends the turn** (`cancelled`) |
| MCP passthrough (HTTP + bearer header) | ✅ 3 calls from 3 distinct session tokens | ✅ 3 calls from 3 distinct session tokens |
| Cost and usage reporting | ✅ `usage_update` with context size, estimated cost and model | ⚠️ not checked in this spike |
| Auth methods advertised | none while a credential is in the environment | `api-key`, `chat-gpt` (needs ACP `authenticate`) |

The raw evidence is in `results/container/*.json`.

## Findings that change the design

1. **Model lists alone don't meet R8.**
   - **What ACP gives:** Claude offers aliases only, and both adapters reject a model they haven't listed.
   - **What works:** the free-text override has to be applied **when the runner starts the agent**. For Claude, pin the alias through `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. For Codex, use `CODEX_CONFIG.model`. This needs a runner restart or a new session, not a live switch.
   - **What the UI should show:** the agent's own list, plus a "pin a specific model ID" field.
2. **Codex's default mode bypasses Boss Man.** `codex-acp` defaults to mode `agent` (shown as "Auto review"). That mode sends approvals to Codex's own AI reviewer ("Guardian Review", a separate model call) instead of the client. The runner must start Codex with `INITIAL_AGENT_MODE=workspace-write` (approval `on-request`, reviewer `user`).
3. **Codex's sandbox needs user namespaces.**
   - **The problem:** `workspace-write` uses bubblewrap. Under Docker's default seccomp profile it fails with "No permissions to create a new namespace", so every command fails.
   - **What doesn't work:** `codex-acp` sets the sandbox from the mode on every turn (`dist/index.js:35610`), so config can't swap it for "full access + approvals".
   - **The options:**
     - (a) A **custom seccomp profile** that allows namespace creation for the runner. `seccomp=unconfined` was verified to work, but it is too broad to ship.
     - (b) A small `codex-acp` patch or upstream PR adding a mode with full access but approvals routed to the user.

     **Recommendation:** (a) for v1, with (b) proposed upstream.
4. **Denials behave differently.**
   - **Claude** returns an error to the model and carries on.
   - **Codex** cancels the whole turn.

   The decision-queue flow must handle both. A Codex agent needs re-waking with the decision attached.
5. **Claude Code in the image.** Anthropic's npm package `@anthropic-ai/claude-code` "installs the same native binary as the standalone installer". It needs no curl or apt in the image, and `DISABLE_UPDATES=1` keeps versions fixed until the image is rebuilt.
   - The adapter also bundles its own Claude binary through the SDK. **`CLAUDE_CODE_EXECUTABLE` must be set**, or the bundled one is used.
6. **Codex's tool interface is "code mode".** The model writes JavaScript for a single `exec` tool, which calls `tools.exec_command`, MCP tools and so on. Boss Man doesn't depend on this, but anything that inspects Codex tool calls should key on ACP `tool_call` events, not on model output.

## Run it yourself

**Without credentials (stub)**, in any Docker host:

```bash
cd spikes/s2-acp
docker build -f Dockerfile.runner -t boss-man-runner:spike .
mkdir -p results/container && chmod 777 results/container
docker run --rm --network none -v "$PWD/results/container:/home/node/runner/results" boss-man-runner:spike --agent claude --sessions 3
docker run --rm --network none --security-opt seccomp=unconfined -v "$PWD/results/container:/home/node/runner/results" boss-man-runner:spike --agent codex --sessions 3
```

**With a real model.** This is the outstanding part of S2. It uses your setup-token, so it counts against your Max plan's usage. The prompt tells the agent to try `rm -rf /srv/precious`. The policy denies it, and the path doesn't exist in the container anyway.

```bash
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN -v "$PWD/results/container:/home/node/runner/results" boss-man-runner:spike --agent claude --sessions 3 --real
```

For Codex with an API key:

```bash
docker run --rm -e OPENAI_API_KEY --security-opt seccomp=unconfined -v "$PWD/results/container:/home/node/runner/results" boss-man-runner:spike --agent codex --sessions 3 --real
```

The build flags `--secret id=extra_ca,...`, `--network host` and `HTTPS_PROXY` were only needed in the sandbox where this spike was developed. A normal Docker host doesn't need them.
