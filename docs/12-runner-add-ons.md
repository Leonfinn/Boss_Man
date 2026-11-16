# 12 — Runner add-ons

**For owners, in short.** An add-on is an optional tool built into the runner image, such as a browser for agents (`agent-browser`) or Safari's engine (`webkit`). Settings → Server and runner → Runner → **Add-ons** lists them and shows which are working. To add one:

1. In the server's `.env`, put its id on the `RUNNER_ADDONS=` line. Separate several with commas and keep the ones already there, for example `RUNNER_ADDONS=agent-browser,webkit`.
2. Choose Settings → Server and runner → Updates → **Build and update runners** (with the host deployer), or run `scripts/update-runner.sh` as root from the checkout.

The add-on shows as Working once the runners are on the new image. To remove one, take its id out of the line and update again.

The rest of this page is the design.

Status: built (steps 1 to 4 below). The owner chose this over a browser running as a separate tool server, because browser checks are central to their projects (24 Oct 2026).

## Rule

A third-party tool may be added to the runner only as an **add-on**: optional, pinned to a version, and removable. Boss Man must work exactly as before if an add-on is missing, broken or no longer supported. Only the skills that need it stop being given out.

## Why add-ons install when the image is built

The runner runs as the non-root `node` user. A browser needs system libraries that only root can install. So add-ons install when the runner image is **built**, as Claude Code and OpenCode already do: new versions arrive by rebuilding (R9), and a build is promoted only once its canary passes (R52). A broken add-on version therefore never replaces a working image.

## Pieces

1. **Catalogue** (`packages/shared`): the add-ons Boss Man knows about. Each entry has an id, the npm package and its pinned version, a check command, the canary commands, and a description. The first entry is `agent-browser` (Vercel Labs, Apache-2.0), pinned to 0.39.0. Its README offers `agent-browser install --with-deps` to download Chrome for Testing and the Linux libraries. Instead, the image installs Debian's `chromium` package with apt, so it gets security updates, and points agent-browser at it with `AGENT_BROWSER_EXECUTABLE_PATH`, which that README documents. That avoids a separate download, and avoids `--with-deps`, which calls `sudo apt-get` (the slim image has no sudo). Chromium's own sandbox is off (`AGENT_BROWSER_ARGS=--no-sandbox`). It needs privileges the runner container doesn't have, and the container is already the boundary, since agents run shell commands in it.
2. **Build argument**: `RUNNER_ADDONS` in the runner Dockerfile, a comma-separated list such as `agent-browser,webkit`. `scripts/update-runner.sh` reads it from the environment or from `.env`. With the argument empty, the build is byte-for-byte what it was before add-ons existed. The Dockerfile is an infra file, so changes to it are applied by hand.
   The second entry is `webkit`: Playwright (Microsoft, Apache-2.0), pinned to 1.64.1, with its WebKit build (Safari's engine) installed by `playwright install --with-deps webkit` while the image is built as root, into `/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`), readable by the `node` user. `NODE_PATH` points at the global modules so an agent's script can `require("playwright")`. It is close to Safari but not Safari: Safari itself only runs on Apple systems. The add-ons' settings (`AGENT_BROWSER_*`, `PLAYWRIGHT_BROWSERS_PATH`, `NODE_PATH`) are passed to agent runs, which otherwise get only a short list of the runner's environment.
3. **Canary**: for each add-on the image holds (listed in `/etc/bossman-addons`), run its canary commands. For agent-browser that means opening `about:blank` headless, then closing it. A failure fails the canary, so the build isn't promoted.
4. **Runner reports**: at connect, the runner tells the server which add-ons it has, their versions, and whether their checks pass. A periodic check catches an add-on that breaks later.
5. **Skills declare needs**: a new nullable column, `skills.requires_addons`. The owner sets it in the skill's settings. The importer sets it for skills it recognises (`dogfood`, `agent-browser`). A run only receives a skill when its runner reports every add-on that skill requires as healthy. Otherwise the skill is left out of that run and the owner gets one notification ("dogfood is off because agent-browser isn't working on App Co's runner").
6. **UI**: Settings → Server and runner → Runner → **Add-ons** lists the catalogue, what's installed with its version and health, and for anything not installed, how to add it (as at the top of this page). A skill's settings (Skills page) have a tick box for each add-on it needs.

## Not in scope

- Installing anything at run time or from inside an agent run.
- Add-ons outside the catalogue. Adding one to the catalogue is a reviewed PR.
- Repo test suites that need a browser (e.g. Playwright in a project's own checks). Those use the same installed browser once the add-on exists, and the project's check command picks it up through `AGENT_BROWSER_EXECUTABLE_PATH` / `PLAYWRIGHT_BROWSERS_PATH`. Wiring that up is a follow-up once the add-on lands.

## Build order

1. Catalogue, `requires_addons` column, and leaving a skill out of runs when the add-on is missing (server + shared; the runner reports nothing yet, so no add-ons count as available).
2. Runner hello and periodic health report; the server stores the latest report per runner.
3. Dockerfile build argument and canary checks (infra PR, applied by hand).
4. Add-ons in the runner settings UI; recognise known skills in the importer.
