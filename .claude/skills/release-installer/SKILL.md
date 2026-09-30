---
name: release-installer
description: Release @postman/postman-plugin, the npx installer and Pi package, to npm - a release candidate on the `next` dist-tag or a plain version on `latest`. Use when asked to cut, publish, tag or ship an installer release or rc, promote an rc to latest, resume a release in progress, or retry one that failed.
argument-hint: rc | latest | <version>
disable-model-invocation: true
allowed-tools: Bash(node .claude/skills/release-installer/scripts/release.mjs:*), Bash(git fetch:*), Bash(git status:*), Bash(git ls-remote:*), Bash(git show:*), Bash(git worktree add:*), Bash(npm ci:*), Bash(npm test:*), Bash(npm pack:*), Bash(npm run test:pi-harness:*), Bash(gh run list:*), Bash(gh run watch:*), Bash(gh pr view:*)
---

# Release @postman/postman-plugin

Release to cut: **$ARGUMENTS** (`rc`, `latest`, or an exact version; if empty, ask which).

Pushing the tag `@postman/postman-plugin@<version>` is the release. `release.yml`
checks the tag, runs the tests, publishes to npm with trusted publishing and
provenance, and creates the GitHub release page. The version picks the dist-tag:
a plain version goes to `latest`, `-rc.N` to `next`.

The helper below does the mechanical parts. Run it from the root of the
checkout you release from:

```bash
node .claude/skills/release-installer/scripts/release.mjs <command>
```

Below, `release.mjs <command>` means that line.

## Rules

- **Publish only by pushing the tag.** Never run `npm publish` yourself, not even
  with `--registry` aimed at a local registry. An `~/.npmrc` that scopes
  `@postman` to npmjs.org outranks `--registry` and publishes to real npm with
  your token.
- **Ask the user before you push a tag.** Say the version and the dist-tag, and
  push only on a yes. npm versions are immutable. `allowed-tools` leaves `git push`
  and `git tag` out on purpose, so the push also asks for permission.
- **Never move or delete a pushed tag.** A release that went wrong gets the next
  version.
- **An rc is tagged on a `release/` branch that never merges.** Push only the
  tag; it carries the commit. `main` only ever carries plain versions.
- **A `latest` release goes through a PR.** `main` needs an approval, and
  `release.yml` refuses a `latest` tag that isn't on `main`. Tag the PR's merge
  commit.
- **The version lives in three files:** `installer/package.json`,
  `installer/package-lock.json` and both headers in `mcp.pi.json`. `bump` sets
  all three, and `npm test` fails when `mcp.pi.json` disagrees.
- **Work in a worktree off `origin/main`**, never in a checkout with other work
  in it.

## Resume first

Run `status`, then find the first matching state for the version and skip to it:

| State | Go to |
| --- | --- |
| The tag is on origin (`git ls-remote --tags origin refs/tags/<tag>`) | Step 5 |
| `latest` only: the release PR is merged, but there's no tag yet | Step 4b, tagging |
| `latest` only: the release PR is open | Step 4b, waiting |
| A `release/postman-plugin-<version>` branch exists, locally or on origin | Step 3's checks, then Step 4 |
| None of these | Step 1 |

## Step 1 — Pick the version

```bash
release.mjs status                            # dist-tags, recent tags, what changed since the last latest
release.mjs suggest rc [patch|minor|major]
release.mjs suggest latest [patch|minor|major]
```

With no level, `suggest` continues an open rc line: `next` is `0.2.0-rc.1` and
`latest` is `0.1.0`, so `rc` gives `0.2.0-rc.2` and `latest` gives `0.2.0`.
Pass a level to start a new line instead. Pick the level from `status`'s
changes:

- **minor**: a new agent route, a new skill, or a new installer command or flag
- **patch**: fixes and wording
- **major**: a breaking change to the CLI's commands, flags or exit codes

Promote an open rc line only when it holds everything `status` lists. Tell the
user the version and why, and wait for their confirmation.

## Step 2 — Pre-flight

```bash
release.mjs check <version>
```

It fails when the version already exists on npm or origin, when it would move its
dist-tag backwards, when `release.yml` can't map it to a dist-tag, or when `gh`
isn't signed in. Fix every `FAIL` before going on.

## Step 3 — Prepare the release commit

```bash
git fetch origin
git worktree add .claude/worktrees/release-<version> -b release/postman-plugin-<version> origin/main
cd .claude/worktrees/release-<version>
node .claude/skills/release-installer/scripts/release.mjs bump <version>
(cd installer && npm ci && npm test && npm pack --dry-run)
```

Also run the Pi harness against a throwaway Pi. It is what CI's `pi` job runs:

```bash
PI_PREFIX=$(mktemp -d) && npm install --no-save --prefix "$PI_PREFIX" @earendil-works/pi-coding-agent
(cd installer && PI_BIN="$PI_PREFIX/node_modules/.bin/pi" npm run test:pi-harness)
```

`git status --short` must show only the three version files. Commit them as
`release: @postman/postman-plugin <version>`.

## Step 4a — Tag an rc

```bash
git tag -a @postman/postman-plugin@<version> -m "@postman/postman-plugin <version>"
```

Confirm with the user, then `git push origin @postman/postman-plugin@<version>`.
Go to Step 5.

## Step 4b — Release `latest` through a PR

```bash
git push -u origin release/postman-plugin-<version>
gh pr create --base main --title "release: @postman/postman-plugin <version>" --body-file <body>
```

The body lists what ships (`status`'s changes since the last `latest`), the
checks Step 3 ran, and that the merge commit gets tagged next. Then stop. The PR
needs an approval, so give the user the PR link and tell them to run
`/release-installer <version>` again once it merges.

Once it has merged, tag the merge commit, after checking it carries the version:

```bash
MERGE=$(gh pr view release/postman-plugin-<version> --json mergeCommit --jq .mergeCommit.oid)
git fetch origin main && git show "$MERGE:installer/package.json" | grep '"version"'
git tag -a @postman/postman-plugin@<version> -m "@postman/postman-plugin <version>" "$MERGE"
```

Confirm with the user, then push the tag.

## Step 5 — Watch the publish

A tag push's run lists the tag as its branch. It can take a few seconds to
appear:

```bash
RUN=$(gh run list --workflow release.yml --branch @postman/postman-plugin@<version> --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --exit-status
```

| `release.yml` failed on | What happened | Do |
| --- | --- | --- |
| the tag does not match `package.json` | the tag is on the wrong commit; nothing was published | cut the next version from Step 1 |
| a latest release must be tagged on main | the tag is not on `main`; nothing was published | cut the next version from Step 1 |
| would move the dist-tag back | a newer version shipped meanwhile; nothing was published | cut a higher version |
| audit or tests | nothing was published | fix it on `main` in its own PR, then cut the next version |
| the release page, after npm published | the package is live and only the page is missing | `gh workflow run release.yml -f tag=<tag>`: it skips the publish and creates the page |
| the npm token exchange (404 on PUT) | the trusted-publisher link is broken, usually a renamed workflow | stop and tell the user; the npm package settings need an owner |

## Step 6 — Verify what shipped

```bash
release.mjs verify <version>
(cd installer && PI_PACKAGE=npm:@postman/postman-plugin@<version> PI_BIN="$PI_PREFIX/node_modules/.bin/pi" npm run test:pi-harness)
```

In a resumed session `PI_PREFIX` is gone; install Pi again as in Step 3.

`verify` checks npm, the dist-tag, the release page and its pre-release flag, and
`npx @postman/postman-plugin@<version> --version`. For `latest` it also reports
whether Pi's gallery lists the package yet; the gallery indexes npm on its own
schedule, so a 404 right after release is not a failure. If npm lags right after
publishing, run `verify` again a minute later. The harness installs the
published version into Pi and checks the skills, the mandate and the MCP server
it registers.

For an rc, ask the user to try it by hand in Pi, the one step no script covers:
`pi install npm:@postman/postman-plugin@<version>`, then `/mcp login postman`
inside a Pi session, and a Postman task.

## Step 7 — Report and clean up

Report the version, the dist-tag, and the links to the npm page, the release page
and the run. Remove the worktree with `git worktree remove`, and delete an rc's
local `release/` branch; its tag keeps the commit.
