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
| Pi package | npm publishes this repo's root package with the same `skills/` dir | none — Pi packages do not declare MCP servers | `@postman/postman-pi` |
| OpenCode plugin | a clone of this repo, loaded by a one-line local plugin that re-exports `opencode/src/index.ts` | `mcp.opencode.json` | `postman-opencode-plugin` |

Codex also reads `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` as
fallbacks — its `DISCOVERABLE_PLUGIN_MANIFEST_PATHS` is `.codex-plugin`,
`.claude-plugin`, `.cursor-plugin`, in that order — so it loaded this repo even
before it had a route of its own. That fallback is not a substitute for one:
Codex would read `mcp.claude-code.json`, whose `headers` key Codex does not
understand, so its traffic arrived with no `X-Source` at all. Keep
`.codex-plugin/plugin.json` first in precedence and Codex never falls back.

OpenCode has no plugin-manifest format, so its route is a local plugin: a
clone of this repository plus a one-line file in OpenCode's `plugins/`
directory that re-exports `opencode/src/index.ts`. OpenCode runs the
TypeScript directly, and the source has no runtime dependencies — its only
imports from OpenCode are `import type` — so nothing is built or installed.
The plugin reads the skills, `hooks/session-start-context.md`,
`manifest.json` and `mcp.opencode.json` from the clone's root. It is not
published to npm.

The default export serves both OpenCode plugin APIs: v1 hosts call
`server()`, v2 hosts call `setup()`. v1's config hook appends the clone's
`skills/` to `skills.paths` and adds the server from `mcp.opencode.json`; v2's
skill and MCP transforms register the same files. Both leave an existing
`postman` MCP entry and existing skill paths untouched. OpenCode has no
session-start event, so the plugin pushes `hooks/session-start-context.md` into
the system prompt, rewriting `` `postman:<skill>` `` to `` `<skill>` `` because
OpenCode's skill names are un-namespaced. The harness installs the plugin the
way a user does — the clone and the one-line file under an isolated global
config directory — and has the pinned OpenCode 1 CLI load every skill.
OpenCode 2 is covered only by unit tests against a mock host.

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
.kimi-plugin/plugin.json          the Kimi Code plugin manifest — carries its MCP block inline
.codex-plugin/plugin.json         the Codex plugin manifest
.app.json                         maps the Codex plugin to its published ChatGPT app ID
package.json                      the publishable @postman/postman-pi package manifest
opencode/                         the OpenCode plugin — source, tests, install harness, routing evals
.opencode/plugins/postman.ts      loads that plugin from source when OpenCode runs inside a clone
mcp.claude-code.json              Claude Code's MCP config
mcp.cursor.json                   Cursor's MCP config
mcp.codex.json                    Codex's MCP config — spells its headers `http_headers`
mcp.opencode.json                 OpenCode's MCP config, read by the plugin at runtime
skills/<name>/SKILL.md            one skill per directory — see skills/ for the current list
manifest.json                     generated index of the skill files
scripts/build-manifest.js         regenerates it
scripts/validate-pi-package.js    verifies Pi metadata and the npm tarball contents
```

## The Pi package

Pi's package catalog discovers public npm packages with the `pi-package`
keyword. The root `package.json` publishes `skills/` directly as
`@postman/postman-pi` and declares that directory under `pi.skills`; it does
not copy or generate a second skill tree. Pi packages have no MCP-server field,
so this route exposes the CLI-driven skills without one of the repository's
`mcp.*.json` files.

Run the same check as CI before releasing:

```bash
npm run check:pi
pi -e npm:@postman/postman-pi
```

The first command validates the Pi metadata and inspects `npm pack --dry-run`
to ensure every skill is present and unrelated repository files are absent.
The second command is the end-to-end smoke test once that version exists on
npm.

Pi releases are independent of the other plugin routes and happen in a
dedicated release commit:

1. Set the root `package.json` version to the release version without changing
   any vendor plugin manifest.
2. Run `npm run check:pi`, publish from an npm account authorized for the
   `@postman` organization with `npm publish --access public`, and push a signed
   `pi-v<version>` tag on the release commit.
3. Verify both `pi -e npm:@postman/postman-pi` and
   `pi install npm:@postman/postman-pi` load the expected skills.
4. Confirm the package appears in the [Pi Package Catalog](https://pi.dev/packages).

The `pi-package` keyword makes a package eligible for catalog discovery; Pi
does not document a separate submission or guaranteed indexing mechanism. If
npm publication succeeds but catalog search does not find it, record that as
an upstream indexing issue rather than adding a second registration path here.

## The MCP server config

Each route has its own config file, so each can report itself in `X-Source` and
traffic can be attributed to the agent it came from:

```
mcp.claude-code.json        <- .claude-plugin/plugin.json  "mcpServers": "./mcp.claude-code.json"
mcp.cursor.json             <- .cursor-plugin/plugin.json  "mcpServers": "./mcp.cursor.json"
mcp.codex.json              <- .codex-plugin/plugin.json   "mcpServers": "./mcp.codex.json"
.kimi-plugin/plugin.json       inline — Kimi documents no path form
mcp.opencode.json           <- opencode/src/index.ts       read at runtime; opencode/package.json holds the version
```

Maintained by hand, and they are not interchangeable copies. Four things
differ per route on purpose, and copying one file over another breaks them
all:

- **`X-Source` must be unique per route.** It is the dimension telemetry keys
  on, so two routes sharing a value collapse into one bucket — which reads
  exactly like an agent nobody uses. Nothing checks this — verify it by eye.
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
  it looks exactly like success. `headers` is right for the other four;
  don't normalize it across all five.

There is no generator, deliberately: a tool whose job is to keep these
identical is wrong once versions are per-route.

Every route names its endpoint outright — `/mcp` for Claude Code, Cursor and
Codex, `/minimal` for Kimi Code and OpenCode. Don't reintroduce a `${POSTMAN_MCP_MODE:-...}`
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
npm run test:harness           # installs it as a user does, then has the pinned CLI load every skill
npm run eval:skills:validate   # every skill has at least one positive routing case
npm run eval:skills            # live routing eval against a configured model
```

`npm run eval:skills -- --case <id>` runs one case, and `--model provider/model`
picks the model. The cases live in `opencode/evals/cases.json`. A routing fix
belongs in the shared skill description or `hooks/session-start-context.md`, and
both reach every route, so rerun the full set after changing either and don't
tune wording for OpenCode alone.

Users run whatever their clone has checked out, so a change reaches them on
their next `git pull` of `main`. A release is still its own version bump:

1. Set the version on the route's three strings (`opencode/package.json` and
   both headers in `mcp.opencode.json`; the unit tests fail if they differ).
2. After it merges, push a signed tag `opencode-v<version>` on that commit.
3. Install it from a fresh clone, on OpenCode 1 and on OpenCode 2, following
   [opencode/README.md](opencode/README.md), and check that each loads the
   skills and the MCP server. The harness can't cover OpenCode 2: its CLI has
   no `debug skill` command.

List it in [OpenCode's ecosystem page](https://opencode.ai/docs/ecosystem/) only
after step 3 passes.

## Changing a skill

1. Edit the file under `skills/<skill>/`.
2. Run `node scripts/build-manifest.js`.
3. Bump the version on every route that ships the change. Routes version
   independently — differing versions across routes are correct, not drift —
   so a bump means the three strings that one route owns: `version` in its
   manifest, plus `X-Plugin-Version` and `User-Agent` in its MCP config (for
   Kimi all three live in the manifest; for Codex the two headers sit under
   `http_headers`, not `headers`; for OpenCode the manifest is
   `opencode/package.json`). Nothing verifies this, so check the route's
   strings against each other before you commit. Don't skip the bump itself
   either: `claude plugin update` compares
   only that string against a version-keyed cache, so a release that changes
   files without bumping it reports "already at the latest version" and
   delivers nothing. Semver here is major for a breaking change to a skill's
   contract, minor for a new skill, patch for wording or a bug fix.
4. Commit all of it. CI runs `--check` and fails if you forget step 2.

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
silently; an eval case that still expects the skill fails CI. Fix or remove
what turns up, then run the manifest script.

## The bindings placeholder

`SKILL.md` may contain `{{POSTMAN_BINDINGS}}`. `postman init` replaces it with a
table of that repository's spec path, collections directory, CLI version, and
workspace id. Anything that consumes a skill without substituting it should leave
the marker alone rather than guess.
