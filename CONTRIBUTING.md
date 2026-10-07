# Contributing

How this repository is put together, and how to change it. For installing and
using the plugin, see [README.md](README.md).

## How the routes work

The skill files in this repository are the single source of truth for every
plugin route below — each route's manifest or package points back at the same
`skills/` directory rather than keeping a copy of its own in git:

| Route | How it gets the files | MCP config it reads | Reports itself as |
| --- | --- | --- | --- |
| Claude Code plugin | `/plugin marketplace add postmanlabs/postman-plugin` clones this repo | `mcp.claude-code.json` | `postman-claude-code-plugin` |
| Cursor plugin | `.cursor-plugin/plugin.json` points at this repo's `skills/` dir | `mcp.cursor.json` | `postman-cursor-plugin` |
| Kimi Code plugin | `.kimi-plugin/plugin.json` points at the same `skills/` dir | `mcpServers` in `.kimi-plugin/plugin.json` | `postman-kimi-plugin` |
| Codex plugin | `.codex-plugin/plugin.json` points at the same `skills/` dir | `mcp.codex.json` | `postman-codex-plugin` |
| Factory Droid plugin | `.factory-plugin/marketplace.json` installs this repo root as the plugin, so Droid reads the same root `skills/` dir | `mcp.json` | `postman-factory-plugin` |
| OpenCode plugin | `opencode plugin add github:postmanlabs/opencode-plugin` installs the mirror `opencode/scripts/build-mirror.js` builds from this repo; `@postman/opencode-plugin` is the same tree on npm; or a clone of this repo, loaded by a one-line local plugin | `mcp.opencode.json` | `postman-opencode-plugin` |
| Pi package | `pi install npm:@postman/postman-plugin` — the installer's npm tarball, which carries `skills/`, `hooks/session-start-context.md` and `mcp.pi.json` staged at pack time | `mcp.pi.json`, registered by `installer/src/pi-extension.ts` | `postman-pi-plugin` |

Codex also reads `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` as
fallbacks — its `DISCOVERABLE_PLUGIN_MANIFEST_PATHS` is `.codex-plugin`,
`.claude-plugin`, `.cursor-plugin`, in that order — so it loaded this repo even
before it had a route of its own. That fallback is not a substitute for one:
Codex would read `mcp.claude-code.json`, whose `headers` key Codex does not
understand, so its traffic arrived with no `X-Source` at all. Keep
`.codex-plugin/plugin.json` first in precedence and Codex never falls back.

OpenCode has no plugin-manifest format; it loads a package whose `package.json`
names a server entrypoint (`exports["./server"]`, else `main`). That package is
[postmanlabs/opencode-plugin](https://github.com/postmanlabs/opencode-plugin),
which nobody edits: `opencode/scripts/build-mirror.js` builds it from this repo —
`opencode/src/index.ts` at `src/`, with `skills/`, the mandate, `manifest.json`
and `mcp.opencode.json` beside it — and two workflows push it:

- **`opencode-mirror.yml`** commits the tree to the mirror's `main` on every push
  to this repo's `main` that changes what it holds, so
  `opencode plugin add github:postmanlabs/opencode-plugin` gets `main` as a clone
  of this repo would.
- **`release.yml`** publishes the same tree to npm as `@postman/opencode-plugin`
  and tags the mirror `v<version>` when `@postman/opencode-plugin@<version>` is
  tagged here.

Both push with `OPENCODE_PLUGIN_TOKEN`, a fine-grained token with Contents read
and write on the mirror only. The mirror's `package.json` takes its version from
`opencode/package.json` and carries no `scripts` or `dependencies`: npm runs a
Git dependency's `prepare`, which would pull dev dependencies into every user's
install. Its `repository` is this repo, which npm's provenance check requires.

The older route still works: a clone of this repository plus a one-line file in
OpenCode's `plugins/` directory that re-exports `opencode/src/index.ts`.
OpenCode runs the TypeScript directly, and the source has no runtime
dependencies — its only imports from OpenCode are `import type` — so nothing is
built or installed. The plugin reads the skills, `hooks/session-start-context.md`,
`manifest.json` and `mcp.opencode.json` from beside its package when
`manifest.json` is there, as in the mirror, and from one level up otherwise, as
in a clone.

The default export serves both OpenCode plugin APIs: v1 hosts call
`server()`, v2 hosts call `setup()`. v1's config hook appends the clone's
`skills/` to `skills.paths` and adds the server from `mcp.opencode.json`; v2's
skill and MCP transforms register the same files. Both leave an existing
`postman` MCP entry and existing skill paths untouched. OpenCode has no
session-start event, so the plugin pushes `hooks/session-start-context.md` into
the system prompt, rewriting `` `postman:<skill>` `` to `` `<skill>` `` because
OpenCode's skill names are un-namespaced. The harness installs the plugin the
way a user does — the clone and the one-line file under an isolated global
config directory — has the pinned OpenCode 1 CLI load every skill, and runs
one session against a stand-in model to check the mandate reaches it. OpenCode
finds its project from `$PWD`, so the harness sets it; inherited, it points at
this clone, whose `.opencode/plugins/postman.ts` would load the plugin instead.
`scripts/test-plugin-add.js` covers the `plugin` routes the same way, each under
a throwaway home with no config directory:

| Route | Installs | Runs in |
| --- | --- | --- |
| `git` | the mirror built from the checkout, as a one-commit repository | `validate.yml` and `installer-smoke.yml` |
| `npm` | that mirror packed, served by a local registry | both |
| `github` | `github:postmanlabs/opencode-plugin` from GitHub, which is `main` as last synced (`PLUGIN_ADD_SPEC` sets the spec) | `installer-smoke.yml` |
| `registry` | `@postman/opencode-plugin` from npm | `installer-smoke.yml`, nightly only |

It then runs `opencode run` against the stand-in and checks the skill list the
installed copy declares, the mandate, that the entry skill loads and that the
MCP server is reached, and on OpenCode 2 that `plugin remove` takes the entry
out of the config. It runs on OpenCode 1 (`opencode plugin --global <spec>`) and
OpenCode 2 (`opencode plugin add <spec>`), on Linux and Windows; the clone
route's harness above runs only on 1, because OpenCode 2 has no `debug skill`.

Inside a clone, `.opencode/plugins/postman.ts` is that same one-line file, so
OpenCode running in this repository loads the plugin from source.

The Postman CLI also has its own path for installing these skills, but it's
still being redesigned — don't treat it as settled or document it here until
it lands.

## Layout

```
.claude-plugin/marketplace.json   the marketplace Claude Code adds
.claude-plugin/plugin.json        the Claude Code plugin manifest
.cursor-plugin/plugin.json        the Cursor plugin manifest
.kimi-plugin/plugin.json          the Kimi Code plugin manifest — carries its MCP block inline, and names Kimi's generated copy of the mandate
.codex-plugin/plugin.json         the Codex plugin manifest
.factory-plugin/marketplace.json  the Factory Droid marketplace
.factory-plugin/plugin.json       the Factory Droid plugin metadata
.app.json                         maps the Codex plugin to its published ChatGPT app ID
opencode/                         the OpenCode plugin — source, tests, install harnesses, routing evals
opencode/scripts/build-mirror.js  builds postmanlabs/opencode-plugin, the package OpenCode installs; opencode-mirror.yml and release.yml push it
installer/                        `npx @postman/postman-plugin` — one adapter per agent in src/hosts/ — and the Pi package
installer/src/pi-extension.ts     the Pi package's extension: the session-start mandate and the MCP server
.opencode/plugins/postman.ts      loads that plugin from source when OpenCode runs inside a clone
mcp.claude-code.json              Claude Code's MCP config
mcp.cursor.json                   Cursor's MCP config
mcp.codex.json                    Codex's MCP config — spells its headers `http_headers`
mcp.json                          Factory Droid's MCP config — must keep this exact root filename
mcp.opencode.json                 OpenCode's MCP config, read by the plugin at runtime
mcp.pi.json                       Pi's MCP config, registered by the Pi extension at runtime
skills/<name>/SKILL.md            one skill per directory — see skills/ for the current list
manifest.json                     generated index of the skill files
scripts/build-manifest.js         regenerates it, and Kimi's copy of the mandate
scripts/routes.js                 every route, read by the pre-commit guard and the installer's tests
```

## The MCP server config

Each route has its own config file, so each can report itself in `X-Source` and
traffic can be attributed to the agent it came from:

```
mcp.claude-code.json        <- .claude-plugin/plugin.json  "mcpServers": "./mcp.claude-code.json"
mcp.cursor.json             <- .cursor-plugin/plugin.json  "mcpServers": "./mcp.cursor.json"
mcp.codex.json              <- .codex-plugin/plugin.json   "mcpServers": "./mcp.codex.json"
.kimi-plugin/plugin.json       inline — Kimi documents no path form
mcp.json                    <- Factory Droid reads this root filename from the installed plugin
mcp.opencode.json           <- opencode/src/index.ts       read at runtime; opencode/package.json holds the version
mcp.pi.json                 <- installer/src/pi-extension.ts   read at runtime; installer/package.json holds the version
```

Maintained by hand, and they are not interchangeable copies. Four things
differ per route on purpose, and copying one file over another breaks them
all:

- **`X-Source` must be unique per route.** It is the dimension route
  attribution keys on, so two routes sharing a value collapse into one bucket
  — which reads
  exactly like an agent nobody uses. Nothing checks this — verify it by eye.
- **One `X-Source` per agent route, whichever way it was installed.** The OpenCode
  plugin reaches users through `github:postmanlabs/postman-plugin`, through
  `@postman/postman-plugin` on npm and through a clone, and all three read the same
  `mcp.opencode.json`. They report `postman-opencode-plugin` and the version in
  `opencode/package.json`, so traffic from the npm package carries that version
  and not the installer's own. The header says which agent sent the request, not
  how it was installed.
- **Versions are independent.** Each route ships on its own cadence, so
  differing versions across routes are correct rather than drift. Within a
  route the manifest `version` and both header strings must agree, and nothing
  enforces that either — a mismatch is accepted at runtime and the traffic is
  filed under a version that was never cut.
- **The URL's mode segment** (`/mcp` vs `/minimal`) selects a different tool
  surface. Unifying it changes which tools the `/minimal` routes (Kimi Code,
  opencode) get — a product decision, not a tidy-up.
- **The header key is `headers` everywhere except Codex**, which spells it
  `http_headers`. Codex deserializes a plugin's MCP config into its own
  `RawMcpServerConfig`, which has only `http_headers` and carries
  `#[schemars(deny_unknown_fields)]` — schemars, for schema generation, not
  serde. So serde ignores unknown keys: a `headers` block in `mcp.codex.json`
  is dropped without an error, the server still connects, and every request
  goes out unattributed. This is the worst failure mode in the repo, because
  it looks exactly like success. `headers` is right for every other route;
  don't normalize Codex to it.

There is no generator, deliberately: a tool whose job is to keep these
identical is wrong once versions are per-route.

Every route names its endpoint outright — `/mcp` for Claude Code, Cursor,
Codex, Factory Droid and Pi, `/minimal` for Kimi Code and OpenCode. Don't reintroduce a `${POSTMAN_MCP_MODE:-...}`
placeholder to express the default: no route expands `${...}` inside an MCP URL,
so the whole segment ships literally and the request never reaches the intended
mode. `claude plugin list --json` reports the registered URL with the
placeholder still in the path, Cursor has no such plugin variable here, and the
Agent Plugins spec is explicit that only `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`
expand and never in a URL. If the mode ever needs to be configurable, resolve it
at build time or behind a stdio wrapper rather than in the URL string.

## Codex marketplace discovery

Codex discovers `.claude-plugin/marketplace.json` — that path is in its
`MARKETPLACE_MANIFEST_RELATIVE_PATHS`, and it accepts that file's
`"source": "./"` string shorthand — so there is no separate Codex marketplace
file to maintain. The `marketplace add` step is required: only
`~/.agents/plugins/marketplace.json` is discovered implicitly.

## The OpenCode plugin

Run these from `opencode/`. CI's `opencode` job runs all but the last, which
needs a model:

```
npm ci
npm test                       # builds, then unit-tests the v1 and v2 entry points
npm run test:harness           # installs it as a user does, has the pinned CLI load every skill and checks what a session sends the model
node scripts/build-mirror.js <dir>   # builds what postmanlabs/opencode-plugin holds and npm publishes
node scripts/test-plugin-add.js git   # the same for `opencode plugin add` from that mirror as a Git repository; for OpenCode 2, OPENCODE_BIN=<path to its opencode>
node scripts/test-plugin-add.js npm   # and from that mirror packed, behind a local registry
node scripts/test-plugin-add.js github   # and from github:postmanlabs/opencode-plugin; PLUGIN_ADD_SPEC=github:postmanlabs/opencode-plugin#v<version> for one release
node scripts/test-plugin-add.js registry   # and from npm: PLUGIN_ADD_SPEC=@postman/opencode-plugin@<version> for one release
npm run eval:skills:validate   # every skill has at least one positive routing case
npm run eval:skills            # live routing eval against a configured model
```

`npm run eval:skills -- --case <id>` runs one case, and `--model provider/model`
picks the model. The cases live in `opencode/evals/cases.json`. A routing fix
belongs in the shared skill description or `hooks/session-start-context.md`, and
both reach every route — Kimi's copy of the mandate once
`node scripts/build-manifest.js` regenerates it — so rerun the full set after
changing either and don't tune wording for OpenCode alone.

A change reaches `github:postmanlabs/opencode-plugin` users once
`opencode-mirror.yml` syncs it after merge, and clone users on their next
`git pull`. npm users get it in a release, which is its own version bump:

1. Set the version on the route's three strings (`opencode/package.json` and
   both headers in `mcp.opencode.json`; the unit tests fail if they differ).
2. After it merges, push a signed tag `@postman/opencode-plugin@<version>` on
   that commit. `release.yml` publishes the mirror tree to npm and tags the
   mirror `v<version>`.
3. Install it with `opencode plugin add @postman/opencode-plugin@<version>`, on
   OpenCode 1 and on OpenCode 2, following
   [opencode/README.md](opencode/README.md), and check that each loads the
   skills and the MCP server. The clone harness can't cover OpenCode 2: its CLI
   has no `debug skill` command; `test-plugin-add.js` covers both versions.

List it in [OpenCode's ecosystem page](https://opencode.ai/docs/ecosystem/) only
after step 3 passes.

## The Pi package

Pi installs the installer's own npm package. `installer/package.json`'s `pi`
key declares `skills/` and one extension, `dist/pi-extension.js`, and its
`pi-package` keyword lists the package in [Pi's gallery](https://pi.dev/packages),
which shows the `latest` version, as npm search does. `prepack` stages
`skills/`, `hooks/session-start-context.md` and `mcp.pi.json` beside `dist/`,
so git still holds one copy of each.

Pi has no hooks file; the extension does the hook's job. It registers the
servers in `mcp.pi.json`, and on `before_agent_start` adds
`hooks/session-start-context.md` to the system prompt as a `<postman>` section,
rewriting `` `postman:<skill>` `` to `` `<skill>` `` as the OpenCode plugin does.
It adds the section only while `api-engineer` is loaded, because `pi config`
can turn skills off. A `postman` server in the user's own `mcp.json` takes
precedence over the registration.

`pi.registerMcpServer` arrived in Pi 0.99.0, and an extension that throws while
loading stops every Pi session from starting. On an older Pi the extension
skips the registration and, on `session_start`, tells the user through
`ctx.ui.notify` that the MCP server needs Pi 0.99.0.

Prompt sections arrived in Pi 0.86.0. On Pi 0.74.0 to 0.85.x the extension
returns the system prompt with the `<postman>` section appended instead. It
returns no prompt on 0.86.0 and later, where a returned prompt replaces the
sectioned one.

The extension declares the few Pi types it uses instead of importing Pi's,
which ship only inside Pi's CLI package. Don't add Pi to `peerDependencies`:
npm installs peers, so every `npx @postman/postman-plugin` would download Pi.

Run these from `installer/`. CI's `pi` job runs the harness against a pinned
Pi; the `Installer smoke` workflow runs it against the latest one nightly:

```
npm test                                      # includes the tarball, extension and skill-rule tests
PI_BIN=<path to pi> npm run test:pi-harness   # installs the packed tarball into Pi under a throwaway home and checks what Pi sends the model and the MCP server
PI_PACKAGE=npm:@postman/postman-plugin@<version> PI_BIN=<path to pi> npm run test:pi-harness   # the same checks against a published version, whose MCP server it checks only as registered
```

The route's version is the installer's, so `X-Plugin-Version` and `User-Agent`
in `mcp.pi.json` move with `installer/package.json` and `npm test` fails when
they differ. A skill change reaches Pi with the next installer release.

## The Kimi Code plugin

Kimi discards a SessionStart hook's output, so the mandate reaches it through
`systemPromptPath` in `.kimi-plugin/plugin.json`, which Kimi Code adds to the
system prompt from 0.31.0 on; older releases load the skills without it. The
file it names, `.kimi-plugin/session-start-context.md`, is
`hooks/session-start-context.md` with `` `postman:<skill>` `` rewritten to
`` `<skill>` ``, because Kimi's skill names are un-namespaced, as Droid's are.
`node scripts/build-manifest.js` writes it, so don't edit it by hand: `--check`
fails CI and the pre-commit guard when it is stale.

## The Factory Droid plugin

Droid reads `.factory-plugin/marketplace.json` first and falls back to
`.claude-plugin/marketplace.json`, so without this route it would install the
Claude Code layout and report its traffic as Claude Code. Droid names the
marketplace after the repository, `postman-plugin`, not after the file's `name`;
the plugin installs as `postman@postman-plugin` and tracks the marketplace's
commit, so `version` is only release metadata there. The headers still carry it.

Droid has no manifest key for MCP: it reads `mcp.json` at the plugin root. That
filename is also Cursor's default, which `.cursor-plugin/plugin.json`'s
`mcpServers` overrides — remove that key and Cursor reports itself as Droid.
`.claude/hooks/validate-manifests.js` fails on that removal, in CI's Manifest job
and as the pre-commit guard.

Droid runs the shared `hooks/hooks.json`, filling in both `${CLAUDE_PLUGIN_ROOT}`
and `${DROID_PLUGIN_ROOT}`, through cmd.exe on Windows. Its skill names are
un-namespaced and its Skill tool rejects `postman:api-engineer`, so when the
hook gets Droid's root as its argument it rewrites `` `postman:<skill>` `` to
`` `<skill>` ``, as the OpenCode plugin does.

`scripts/factory-harness.js` installs this checkout into Droid as a local
marketplace under a throwaway home and runs one `droid exec` against a local
stand-in for both the model and the MCP server. It checks that the session
lists every skill and carries the mandate, that the mandated skill loads, and
that the MCP requests carry `mcp.json`'s headers. CI's `factory` job runs it
against a pinned Droid; the `Installer smoke` workflow runs it against the
latest one nightly:

```
DROID_BIN=<path to droid> node scripts/factory-harness.js
```

## Checking what each route delivers

Each route has a harness that installs this checkout the way a user gets it,
under a throwaway home, and checks what the agent sends its model and the MCP
server: every skill in `manifest.json` listed, the session-start mandate in the
form that agent resolves (`postman:` names for Claude Code and Codex, bare names
elsewhere), the skill the mandate names loaded, and the route's MCP headers.
`scripts/lib/harness.js` holds the stand-in they share. CI's job per route runs
each harness against a pinned agent; the `Installer smoke` workflow runs it
against the latest one nightly.

```
CLAUDE_BIN=<path to claude> node scripts/claude-code-harness.js
CODEX_BIN=<path to codex> node scripts/codex-harness.js
KIMI_BIN=<path to kimi> node scripts/kimi-harness.js
CURSOR_API_KEY=<key> CURSOR_BIN=<path to cursor-agent> node scripts/cursor-harness.js
DROID_BIN=<path to droid> node scripts/factory-harness.js
(cd opencode && npm run test:harness)
(cd installer && PI_BIN=<path to pi> npm run test:pi-harness)
```

Each `*_BIN` defaults to the agent's command on `PATH`. Codex skips a plugin's
hook until the user trusts it, so its harness runs twice: untrusted, which must
carry the skills and no mandate, and with `--dangerously-bypass-hook-trust`,
which must carry both. Cursor's CLI has no stand-in model, so its harness asks
Cursor's model to quote the mandate and the skill it names, and needs a
`CURSOR_API_KEY`; CI reads it from the repository secret of that name. It
loads the plugin with `--plugin-dir`, because the CLI ignores
`~/.cursor/plugins/local`, where the installer puts it
([#82](https://github.com/postmanlabs/postman-plugin/issues/82)), so it checks
the plugin, not the installer's Cursor install. It runs on Linux only: the
Cursor CLI on Windows runs no `sessionStart` hook headless
([#83](https://github.com/postmanlabs/postman-plugin/issues/83)).

## The installer

`installer/` is `npx @postman/postman-plugin`. It detects each supported agent
on the machine and installs this plugin into it, through the agent's own CLI
wherever one exists:

| Agent | What it runs |
| --- | --- |
| Claude Code | `claude plugin` against Anthropic's `claude-plugins-official` catalog, then uninstalls a user-scope `postman@postman` so skills don't load twice; a failed install leaves that copy in place |
| Codex | `codex plugin` against this repo as the `postman` marketplace |
| Cursor | a clone at `~/.cursor/plugins/local/postman`. A fresh install is skipped when the Cursor Marketplace copy is present, but an existing clone is kept and updated: Cursor keeps a disabled Marketplace copy on disk too, so the installer can't tell whether that copy is enabled |
| Factory Droid | `droid plugin` against this repo as the `postman-plugin` marketplace |
| Kimi Code | `npx --package=plugins@1.3.4 plugins add postmanlabs/postman-plugin --target kimi`, because Kimi installs plugins only from its TUI |
| OpenCode | `opencode plugin add github:postmanlabs/opencode-plugin` on OpenCode 2.0.4 or later, `opencode plugin --global …` on OpenCode 1.14.33 or later. It reads the global config (`plugins`, or `plugin` on OpenCode 1, in `opencode.json` or `opencode.jsonc`) to see what is installed, removes with `opencode plugin remove` on OpenCode 2 and otherwise by editing the config entry — on OpenCode 1, and on 2 when the entry is in `opencode.jsonc` beside an `opencode.json`, the only file `plugin remove` edits — and then deletes an older clone-and-loader install so no skill loads twice. It updates by re-running with `--force` on OpenCode 1 and, on OpenCode 2, by deleting the cached copy under `<cache>/opencode/npm/git-opencode-plugin-*` and adding again: `plugin add` reuses that cache, and `plugin update`, `list` and `check` need OpenCode's background service, which a second instance on the same port or a cold start answers wrongly. It refuses to refresh an entry that the refresh would not write back to, where it would register a second copy instead: on OpenCode 2 one outside the first of `opencode.json`, `opencode.jsonc` and their `.opencode/` copies that exists, which is the file `plugin add` edits; on OpenCode 1 one in `OPENCODE_CONFIG_DIR`, which `plugin --global` ignores. An existing npm install is held to npm's minimum, 1.14.22 on OpenCode 1. An npm-installed entry is left for `opencode plugin update`, or on OpenCode 1 a forced re-run with an explicit version: its cached `<name>@latest` is never re-fetched. `POSTMAN_PLUGIN_OPENCODE_SPEC` installs another spec instead, which installer smoke sets to the mirror built from a pull request |
| Pi | `pi install npm:@postman/postman-plugin`, or `pi update` when it's installed, then `pi remove` for any git install of this repo, which would load the same skills twice |

Every agent but Pi gets the plugin from GitHub, not from the npm package, so a
skill change needs no installer release. On Claude Code, a route release
reaches installer users when Anthropic's catalog moves its pin for `postman`.
The installer's version is its own, independent of every other route's. Pi gets
the package's `latest`, whichever version of the installer runs the adapter —
see [The Pi package](#the-pi-package).

Run these from `installer/`:

```
npm ci
npm test                             # builds, then pins each adapter's command sequence
node dist/cli.js status              # what it detects on this machine, and what's installed
node dist/cli.js install --dry-run   # the commands an install would run
```

`npm test` fails when a route in `scripts/routes.js`, or any `.*-plugin/`
directory, has no adapter whose `route` names it, so a new route can't ship
without one. The `Installer smoke` workflow runs the installer against the
latest release of every agent it supports, on Linux and Windows, on every
installer change, nightly, and before every release, so a change to an agent's
commands or output fails CI even when nothing here changed.

To release it, run `/release-installer rc`, `/release-installer latest` or
`/release-installer <version>` in Claude Code. The skill in
`.claude/skills/release-installer/` walks these steps, and resumes a release
already under way:

1. Set the version with
   `node .claude/skills/release-installer/scripts/release.mjs bump <version>`,
   which writes it to `installer/package.json`, its lockfile and both headers in
   `mcp.pi.json`. Commit a release candidate (`-rc.N`) on a
   `release/postman-plugin-<version>` branch that never merges, so `main`
   carries only plain versions. Merge a plain version as its own PR.
2. Run `node .claude/skills/release-installer/scripts/release.mjs smoke <commit>`
   on the commit you will tag. It dispatches `Installer smoke` on exactly that
   commit and exits 0 only when it is green. It runs before the tag because a
   pushed tag is the release: a failure after it would burn the version.
3. Push an annotated tag `@postman/postman-plugin@<version>` on that commit: the
   rc branch's commit, or the PR's merge commit. `release.yml` checks that the tag matches `package.json`,
   runs the tests, and publishes with npm trusted publishing and provenance: a
   release candidate goes to the `next` dist-tag (`npx @postman/postman-plugin@next`),
   `-alpha.N`, `-beta.N` and `-canary.N` go to a dist-tag of that name, and a plain
   version goes to `latest` and must be tagged on `main`. Any other prerelease, and
   any version older than the one its dist-tag already points at, is refused.
4. Never move a pushed tag; a release that went wrong gets the next version. To
   retry a tag, run the workflow by hand. A version already on npm is not
   published again, so a retry still creates a release page that failed the
   first time: `gh workflow run release.yml --ref <tag> -f tag=<tag>`. On the
   tag's ref, the retry is listed under the tag like the original run.
   `-f dry_run=true` needs the tag on origin already, and pushing a tag
   publishes it, so a new version can't be rehearsed in CI: `npm pack --dry-run`
   in `installer/` is the rehearsal.

Keep the workflow's filename: npm's trusted publisher for the package is
pinned to `release.yml`.

## Changing a skill

1. Edit the file under `skills/<skill>/`.
2. Run `node scripts/build-manifest.js`.
3. Commit all of it. CI runs `--check` and fails if you forget step 2.

Don't bump a version in the change itself; each route's own release PR does
that (see `AGENTS.md`). Routes version independently — differing versions
across routes are correct, not drift — so a release bumps the three strings
that one route owns: `version` in its manifest, plus `X-Plugin-Version` and
`User-Agent` in its MCP config (for Kimi all three live in the manifest; for
Codex the two headers sit under `http_headers`, not `headers`; for OpenCode
the manifest is `opencode/package.json`, which the mirror's `package.json` copies; for Pi it is
`installer/package.json`, so Pi's bump is an installer release; for Factory
Droid the MCP config is the root `mcp.json`). Nothing verifies this, so check
the route's strings against each other before you commit the release. Don't
skip the release's bump either: `claude plugin update` compares only that
string against a version-keyed cache, so a release that changes files
without bumping it reports "already at the latest version" and delivers
nothing. Semver here is major for a breaking change to a skill's contract,
minor for a new skill, patch for wording or a bug fix.

`marketplace.json` deliberately declares no version — it would override
`plugin.json` and give that route a second source of truth.

Step 2 is not optional — `manifest.json` carries a `sha256` per file, and a
stale manifest silently drifts from what the files actually contain instead
of failing loudly.

## Adding a skill

Create `skills/<name>/SKILL.md` with `name` and `description`
frontmatter, where `name` matches the directory. Add at least one case that
expects it to `opencode/evals/cases.json` — CI's `opencode` job fails for a
skill with none. Run the manifest script.

## Removing a skill

Delete `skills/<name>/`, then grep the rest of the repo for that name —
`grep -rn "<name>" README.md CONTRIBUTING.md skills/ hooks/ intent.md opencode/evals/` —
since other `SKILL.md` files, the session-start context and these docs can reference
a skill by name in prose, not just in frontmatter. Most stale references fail
silently; a `postman:<name>` reference or an eval case that still expects the
skill fails CI. Fix or remove
what turns up, then run the manifest script.

## The bindings placeholder

`SKILL.md` may contain `{{POSTMAN_BINDINGS}}`. `postman init` replaces it with a
table of that repository's spec path, collections directory, CLI version, and
workspace id. Anything that consumes a skill without substituting it should leave
the marker alone rather than guess.
