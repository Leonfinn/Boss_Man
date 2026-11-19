# Published images and releases

How Boss Man's ready-made images are built, published, signed and released (BOS-973; plan: BOS-935, DR-050). Nothing here names a registry or an account: the places to publish to are settings.

## What happens

- **Every merge to `main` that passes CI** runs the *Publish images* workflow (`.github/workflows/publish.yml`). It builds the images natively on x86 and ARM, pushes them once to the first registry in your list, and copies the finished image to the others **by digest**. If any copy has a different digest the run fails, so one signed `release.json` covers every registry. The images get the tag `sha-<first 12 characters of the commit>` and nothing else.
- **Each image is signed** without a key (Sigstore keyless signing, tied to the workflow run) and carries an **SBOM** and **provenance**, both attached for each architecture. Signatures and attachments are stored per registry, so the workflow checks all of them in **every** registry. It also checks that `/NOTICE` is inside each image.
- **The owner's beta button** is the *Release* workflow (`.github/workflows/release.yml`): GitHub → Actions → Release → Run workflow → branch `main` → type a version such as `0.1.0-beta.1`. Leave the optional **commit** box blank to release main's newest commit, or type the full 40-character sha of an older green main commit whose images are already published: while merges are busy main moves every few minutes and the newest commit's images are rarely finished when you press the button. A commit that is not on `main`, is not 40 hex characters or has no `sha-` images is refused before anything is tagged; the signature still comes from the workflow on `main`. It rebuilds nothing. It checks the released commit's images in every registry, gives them the version tag and the moving `beta` tag, and publishes a signed `release.json` as a GitHub pre-release. A version can be released once.
- **`release.json`** lists each image's digest, and its digest per architecture, plus the registries and the commit. Nothing in Boss Man reads it yet: installs still build their images on the host. A future updater is meant to trust only this file (verify it with `cosign verify-blob`, identity `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/heads/main`, issuer `https://token.actions.githubusercontent.com`).

The rules are in `scripts/publish-images.sh`, tested by `scripts/publish-images.test.sh` (a fake registry, no network).

## Settings

Variables: repository Settings → Secrets and variables → Actions → Variables. Secrets: the `publish` environment (Settings → Environments → publish).

| Name | Kind | Meaning |
|---|---|---|
| `IMAGE_PREFIXES` | variable | Space- or comma-separated `<registry>/<namespace>` list; the first is pushed to, the others get a copy. Empty means `ghcr.io/<repository owner>`. Only `ghcr.io` and `docker.io` have a login step. |
| `DOCKERHUB_PUBLISH` | variable | `true` turns Docker Hub on. Once on, a `docker.io/<namespace>` entry must be in the list and both secrets must exist, or the run **fails** (it never skips). Off: `docker.io` entries are ignored. |
| `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | secrets of the **`publish` environment** | Docker Hub account name and a read-and-write access token. Keep them in the `publish` environment (limited to `main`), never as ordinary repository secrets: agent branches run Actions too and could read a repository secret. |
| `PUBLISH_IMAGES` | variable | Image names to publish. Default: `boss-man-server boss-man-launcher boss-man-netguard`. |

The runner image (`boss-man-runner`) is **not** in the default set. Since the Claude pack (BOS-972) it holds no Claude Code (Claude is installed on first start), so to publish it, add `boss-man-runner` to `PUBLISH_IMAGES`. The publish job then refuses the runner unless `scripts/image-tests.sh no-anthropic` passes on it (with the expected-fail marker off).

## Setting it up (any host; the account steps are on the registries' own sites)

1. GitHub's registry needs nothing in the repository: the workflow uses the run's own token. After the first publish, each package starts private. The images contain the app's source, so make a package public **only once Repo cleanup 5 is done**. Then: GitHub → your profile or organisation → Packages → the package → Package settings → Danger zone → Change visibility → Public. Do it for each published image.
2. For Docker Hub: create the account or organisation, then one repository for each published image, named exactly like the image (`boss-man-server`, `boss-man-launcher`, `boss-man-netguard`, later `boss-man-runner`). Create each as **Private** (Docker Hub defaults to public): the images contain the app's source, so switch them to public only once Repo cleanup 5 is done. Cost: Docker Hub's free plan allows one private repository, so four private repositories need a paid plan. Without one, leave `DOCKERHUB_PUBLISH` off (ghcr only) until Repo cleanup 5 is done.
3. Create an access token on Docker Hub (Account settings → Personal access tokens) with *Read & Write* permission (scope it to the published repositories if Docker Hub offers that).
4. In GitHub: repository Settings → Environments → New environment, named `publish`. Under Deployment branches and tags choose *Selected branches and tags*, add `main`. Under Environment secrets add `DOCKERHUB_TOKEN` (the token) and `DOCKERHUB_USERNAME` (your Docker Hub name). Do not add them under Secrets and variables → Actions.
5. Set the variables: `IMAGE_PREFIXES` to `ghcr.io/<your GitHub owner> docker.io/<your Docker Hub namespace>` and `DOCKERHUB_PUBLISH` to `true`.

## Checking by hand

```
docker buildx imagetools inspect <registry>/<namespace>/boss-man-server:sha-<12 characters>
```

Both registries must print the same `Digest:`. To verify a signature yourself:

```
cosign verify --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp '^https://github.com/<owner>/<repo>/\.github/workflows/(publish|release)\.yml@refs/heads/main$' <registry>/<namespace>/boss-man-server@sha256:<digest>
```

## If something goes wrong

- **Undo a bad publish:** the `sha-` tags are harmless; nothing pulls them until a release. To stop publishing, set the `IMAGE_PREFIXES` variable to an unusable value or disable the *Publish images* workflow in the Actions tab. Reverting the commit that added the workflows has the same effect.
- **A release you regret:** delete the GitHub release and its tag, then re-point `beta` by releasing a newer version.
- **Docker Hub's download limit:** anonymous pulls from Docker Hub are rate-limited; GitHub's registry is not. Anyone pulling by hand can use the `ghcr.io` copy instead (the digest is identical).
