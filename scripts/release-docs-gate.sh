#!/usr/bin/env bash
# The release's docs gate (BOS-2666): a release only goes out when the docs match the code. It runs in the Release workflow
# before any image is tagged or any GitHub release is made, for the weekly run and for the pressed button alike, and its
# rules are tested without GitHub in scripts/release-docs-gate.test.sh. Generic: the repo comes from GITHUB_REPOSITORY.
#
#   release-docs-gate.sh stage-of <version>   alpha | beta | rc | stable (from 0.1.0-beta.3, 0.2.0-rc.1, 1.0.0). The one
#                                             place that decides the stage: the moving image tag, --prerelease, the notes
#                                             heading and the wording check below all use it.
#   release-docs-gate.sh prev                 the commit the newest GitHub release was made from (empty when none)
#   release-docs-gate.sh covered <sha>        is a recorded docs check good for that commit? (exit 0 or 1, reason on stderr)
#   release-docs-gate.sh check <version> <sha> [prev-sha]
#                                             the whole gate: prints one "file:line: reason" per problem, then one line
#                                             "Release blocked: ..." and exits 1; exits 0 when everything is fine.
#
# The three rules (all read from the git tree of <sha>, not the working copy):
# 1. Stage wording. README.md and the other root guides, docs/*.md, the website source (apps/site/src), the description
#    of every package.json and the GitHub "About" text (when the API gives it) must not name an OLDER stage than the one
#    being released ("alpha" in a beta). CHANGELOG.md is left out: it is the history. A real mention that is not about the
#    current stage goes in scripts/release-docs-allow.txt with a reason, or carries the words "release-docs-ok" on the line.
# 2. What's new. CHANGELOG.md must have at least one new bullet since the previous release (the same lines
#    scripts/release-notes.sh puts in the release notes). Empty notes fail.
# 3. Docs checked. CHANGELOG.md holds one line "<!-- Docs checked up to <sha> -->", written by the Release Manager after his
#    docs-versus-code check. The rule: every commit after that sha, up to the commit released, may touch only the docs paths
#    in scripts/release-docs-paths.txt. Why this and not "the sha must be the release commit": the line is written by a
#    commit that comes after the code it covers, so "no older than the release commit" would refuse every single week. A
#    code commit after the checked sha means nobody has compared the docs with it yet, so that commit is not released
#    (release-pick.sh uses the same rule to choose the newest commit that is covered).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOW_FILE="${RELEASE_DOCS_ALLOW:-$HERE/release-docs-allow.txt}"
PATHS_FILE="${RELEASE_DOCS_PATHS:-$HERE/release-docs-paths.txt}"
CHANGELOG="${RELEASE_NOTES_FILE:-CHANGELOG.md}"

die() { echo "release-docs-gate: $*" >&2; exit 2; }

stage_of() {
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*-alpha|[0-9]*.[0-9]*.[0-9]*-alpha.*) echo alpha ;;
    [0-9]*.[0-9]*.[0-9]*-beta|[0-9]*.[0-9]*.[0-9]*-beta.*) echo beta ;;
    [0-9]*.[0-9]*.[0-9]*-rc|[0-9]*.[0-9]*.[0-9]*-rc.*) echo rc ;;
    [0-9]*.[0-9]*.[0-9]*-*) return 1 ;;
    [0-9]*.[0-9]*.[0-9]*) echo stable ;;
    *) return 1 ;;
  esac
}

# The words that name a stage older than $1, as an extended regular expression ("" when there is none).
older_words() {
  case "$1" in
    alpha) echo "" ;;
    beta) echo "alpha" ;;
    rc) echo "alpha|beta" ;;
    stable) echo "alpha|beta|release candidate" ;;
  esac
}

# The checked sha written in the CHANGELOG at commit $1; prints it, or returns 1 with the reason on stderr.
checked_sha() {
  local text n
  text="$(git show "$1:$CHANGELOG" 2>/dev/null)" || { echo "$CHANGELOG is missing at ${1:0:12}" >&2; return 1; }
  n="$(printf '%s\n' "$text" | grep -cE '^<!-- Docs checked up to [0-9a-f]{7,40} -->$' || true)"
  if [ "$n" = 0 ]; then echo "$CHANGELOG has no line \"<!-- Docs checked up to <sha> -->\"" >&2; return 1; fi
  if [ "$n" != 1 ]; then echo "$CHANGELOG has $n \"Docs checked up to\" lines, it must have exactly one" >&2; return 1; fi
  printf '%s\n' "$text" | sed -nE 's/^<!-- Docs checked up to ([0-9a-f]{7,40}) -->$/\1/p'
}

path_is_docs() {
  local f="$1" pat
  while IFS= read -r pat; do
    pat="${pat%%#*}"; pat="$(echo "$pat" | sed -E 's/[[:space:]]+$//; s/^[[:space:]]+//')"
    [ -n "$pat" ] || continue
    # shellcheck disable=SC2254 # the patterns are globs on purpose; * also matches "/"
    case "$f" in $pat) return 0 ;; esac
  done < "$PATHS_FILE"
  return 1
}

cmd_covered() {
  local sha="${1:?commit}" checked full bad="" f
  checked="$(checked_sha "$sha")" || return 1
  full="$(git rev-parse --verify -q "$checked^{commit}")" || { echo "the docs-checked sha $checked is not in this repository's history" >&2; return 1; }
  git merge-base --is-ancestor "$full" "$sha" || { echo "the docs-checked sha ${full:0:12} is not an ancestor of ${sha:0:12}" >&2; return 1; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    path_is_docs "$f" || { bad="$f"; break; }
  done < <(git log --no-merges --name-only --format= "$full..$sha")
  if [ -n "$bad" ]; then
    echo "docs were last checked up to ${full:0:12}, and a later commit changed $bad, which is not a docs file" >&2
    return 1
  fi
}

# "path:line: text" hits of an older stage word in the tree of $1; allowlisted ones removed.
wording_hits() {
  local sha="$1" words="$2" raw line path rest num text a_path a_text
  [ -n "$words" ] || return 0
  raw="$( { git grep -n -I -i -w -E "$words" "$sha" -- 'README.md' 'CONTRIBUTING.md' 'SECURITY.md' 'SUPPORT.md' \
      ':(glob)docs/*.md' 'apps/site/src' 2>/dev/null || true
    git grep -n -I -i -E "\"description\"[[:space:]]*:[[:space:]]*\"([^\"]*[^[:alnum:]\"])?($words)([^[:alnum:]\"][^\"]*)?\"" "$sha" -- ':(glob)**/package.json' 'package.json' 2>/dev/null || true; } | sort -u)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    line="${line#"$sha":}"
    path="${line%%:*}"; rest="${line#*:}"; num="${rest%%:*}"; text="${rest#*:}"
    case "$text" in *release-docs-ok*) continue ;; esac
    if [ -f "$ALLOW_FILE" ]; then
      local excused=0
      while IFS='|' read -r a_path a_text _; do
        a_path="$(echo "$a_path" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
        a_text="$(echo "$a_text" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
        case "$a_path" in ''|'#'*) continue ;; esac
        if [ "$a_path" = "$path" ] && [ -n "$a_text" ] && [[ "${text,,}" == *"${a_text,,}"* ]]; then excused=1; break; fi
      done < "$ALLOW_FILE"
      [ "$excused" = 0 ] || continue
    fi
    echo "$path:$num: still says an older stage: $(echo "$text" | sed -E 's/^[[:space:]]+//' | cut -c1-100)"
  done <<< "$raw"
}

cmd_check() {
  local version="${1:?version}" sha="${2:?commit}" prev="${3:-${RELEASE_PREV_SHA:-}}"
  local stage words problems=() hits n why desc repo
  sha="$(git rev-parse --verify -q "$sha^{commit}")" || die "commit $sha is not in this repository"
  stage="$(stage_of "$version")" || { echo "Release blocked: can't tell the stage of version '$version' (use x.y.z, x.y.z-alpha.N, -beta.N or -rc.N)"; return 1; }
  words="$(older_words "$stage")"

  # 1. Stage wording.
  hits="$(wording_hits "$sha" "$words")"
  if [ -n "$hits" ]; then
    echo "$hits"
    n="$(echo "$hits" | wc -l | tr -d ' ')"
    problems+=("stage wording: $n place(s) still name an older stage than $stage (see the lines above)")
  fi
  # The GitHub About text, only when the API gives it (a public repo does). Only the owner can change it.
  repo="${GITHUB_REPOSITORY:-}"
  if [ -n "$repo" ] && [ -n "$words" ] && command -v gh > /dev/null 2>&1; then
    # stderr is kept (2>&1) so a skip can say why; on success gh prints nothing on stderr.
    if desc="$(gh api "repos/$repo" --jq '.description // ""' 2>&1)"; then
      if [ -n "$desc" ] && echo "$desc" | grep -qiwE "$words"; then
        echo "GitHub repository About: \"$(echo "$desc" | cut -c1-100)\": still says an older stage. Only the owner can change it (repository page, the gear next to About); the CEO raises that card."
        problems+=("the GitHub About description names an older stage (the owner must change it)")
      fi
    else
      why="$(printf '%s' "$desc" | head -c 200 | tr '\n' ' ')"
      [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || why="no GH_TOKEN or GITHUB_TOKEN is set for this step. ${why}"
      echo "release-docs-gate: SKIPPED the GitHub About check: could not read the About description (${why:-no reason given}). The About text was NOT checked." >&2
    fi
  fi

  # 2. What's new.
  if [ -n "$prev" ] && git cat-file -e "$prev^{commit}" 2>/dev/null; then
    n="$(git diff --no-color -U0 "$prev" "$sha" -- "$CHANGELOG" | grep -c '^+- ' || true)"
  else
    n="$(git show "$sha:$CHANGELOG" 2>/dev/null | grep -c '^- ' || true)"
  fi
  if [ "${n:-0}" -eq 0 ]; then
    echo "$CHANGELOG:1: no new \"What's new\" entry since the last release, so the release notes would be empty"
    problems+=("What's new is empty ($CHANGELOG has no new entry since the last release)")
  fi

  # 3. Docs checked.
  if ! why="$(cmd_covered "$sha" 2>&1)"; then
    echo "$CHANGELOG: $why"
    problems+=("docs check not recorded for this commit: $why")
  fi

  if [ "${#problems[@]}" -gt 0 ]; then
    local joined="" p
    for p in "${problems[@]}"; do joined="${joined:+$joined; }$p"; done
    echo "Release blocked: $joined"
    return 1
  fi
  echo "release-docs-gate: ok for $version ($stage) at ${sha:0:12}"
}

cmd_prev() {
  local repo tag sha
  repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY}"
  tag="$(gh release list --limit 1 --json tagName --jq '.[0].tagName // ""')" || die "could not list the releases"
  [ -n "$tag" ] || return 0
  sha="$(gh api "repos/$repo/releases/tags/$tag" --jq .target_commitish)" || die "could not read $tag"
  if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then echo "$sha"; fi
}

case "${1:-}" in
  stage-of) shift; stage_of "${1:?version}" || { echo "release-docs-gate: can't tell the stage of '$1'" >&2; exit 1; } ;;
  prev) cmd_prev ;;
  covered) shift; cmd_covered "$@" ;;
  check) shift; cmd_check "$@" ;;
  *) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac
