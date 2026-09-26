# Postman for Agents

Postman's skills for coding agents.

The skill files in this repository are the single source of truth for every
plugin route below — each route's manifest or config points back at the same
`skills/` directory rather than copying files into itself:

| Route | How it gets the files | MCP config it reads | Reports itself as |
| --- | --- | --- | --- |
| Claude Code plugin | `/plugin marketplace add postmanlabs/postman-plugin` clones this repo | `mcp.claude-code.json` | `postman-claude-code-plugin` |
| Cursor plugin | `.cursor-plugin/plugin.json` points at this repo's `skills/` dir | `mcp.cursor.json` | `postman-cursor-plugin` |
| Kimi Code plugin | `.kimi-plugin/plugin.json` points at the same `skills/` dir | `mcpServers` in `.kimi-plugin/plugin.json` | `postman-kimi-plugin` |
| Codex plugin | `.codex-plugin/plugin.json` points at the same `skills/` dir | `mcp.codex.json` | `postman-codex-plugin` |
| OpenCode | `@postman/opencode-plugin` adds this package's absolute `skills/` path | `config` hook in `opencode/index.ts` | `postman-opencode-plugin` |

Codex also reads `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` as
fallbacks — its `DISCOVERABLE_PLUGIN_MANIFEST_PATHS` is `.codex-plugin`,
`.claude-plugin`, `.cursor-plugin`, in that order — so it loaded this repo even
before it had a route of its own. That fallback is not a substitute for one:
Codex would read `mcp.claude-code.json`, whose `headers` key Codex does not
understand, so its traffic arrived with no `X-Source` at all. Keep
`.codex-plugin/plugin.json` first in precedence and Codex never falls back.

OpenCode is the npm route. Its plugin `config` hook appends an absolute path to
the package's canonical `skills/` directory and adds the hosted Postman MCP
server without replacing user configuration. An
`experimental.chat.system.transform` hook injects the shared
`hooks/session-start-context.md`; at runtime it removes the `postman:` prefix
because OpenCode's native skill IDs are un-namespaced. The content stays
single-sourced while the vocabulary matches OpenCode.

A clone uses `.opencode/plugins/postman.ts`, a tiny development adapter that
imports the same implementation. The npm package exports the compiled module
from `dist/index.js`. Do not put local file paths in `opencode.json`'s `plugin`
array: OpenCode documents that array for npm package names and auto-loads local
plugins from `.opencode/plugins/`.

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
.opencode/plugins/postman.ts      OpenCode development adapter for a repository clone
opencode/index.ts                 OpenCode npm plugin implementation
opencode.json                     minimal project config; the development adapter is auto-loaded
mcp.claude-code.json              Claude Code's MCP config
mcp.cursor.json                   Cursor's MCP config
mcp.codex.json                    Codex's MCP config — spells its headers `http_headers`
skills/<name>/SKILL.md            one skill per directory — see skills/ for the current list
manifest.json                     generated index of the skill files
scripts/build-manifest.js         regenerates it
scripts/test-opencode-harness.js  packs, installs and exercises the OpenCode plugin
scripts/eval-opencode-skills.js   runs the OpenCode skill-routing evaluation set
evals/opencode/cases.json         positive and negative routing cases
```

## Installing

Claude Code:

```
/plugin marketplace add postmanlabs/postman-plugin
/plugin install postman@postman
```

Cursor or Kimi Code:

```
npx plugins add postmanlabs/postman-plugin
```

Codex:

```
codex plugin marketplace add postmanlabs/postman-plugin
codex plugin add postman@postman
```

Codex discovers `.claude-plugin/marketplace.json` — that path is in its
`MARKETPLACE_MANIFEST_RELATIVE_PATHS`, and it accepts that file's
`"source": "./"` string shorthand — so there is no separate Codex marketplace
file to maintain. The `marketplace add` step is required: only
`~/.agents/plugins/marketplace.json` is discovered implicitly.

OpenCode, after `@postman/opencode-plugin` has been published to npm:

```
opencode plugin @postman/opencode-plugin --global
```

Omit `--global` to add it only to the current project. OpenCode adds the npm
package to the config and installs it at startup. A contributor testing a clone
can run OpenCode from anywhere inside this repository; the checked-in local
adapter is discovered automatically.

The package is publish-ready but installing by name will work only after a
Postman npm maintainer publishes it. See the
[OpenCode plugin plan](https://github.com/postmanlabs/postman-plugin/blob/main/docs/opencode-plugin-plan.md)
for testing and release gates.

The MCP server answers an unauthenticated request with a 401 that advertises
OAuth, and opencode starts that flow on its own. If the browser prompt never
appears, run `opencode mcp auth postman`.

## Data sent to Postman

Postman CLI commands these skills run report to Postman by default. There are
two separate paths, and only one of them can be turned off.

### Declinable: `--no-report-events`

Seven commands send analytics — and in `application test`'s case the run
results too — unless you opt out:

| Command | Sent by default |
| --- | --- |
| `postman collection run` | Run analytics (see the note below on run history) |
| `postman application test` | Run results and analytics |
| `postman spec lint` | Lint analytics (violation counts, pass/fail) |
| `postman workspace push` | Push analytics |
| `postman runner start` | Runner analytics |
| `postman flows run` | Flow run analytics |
| `postman request` | Request analytics |

**Use the command-specific opt-out spelling shown above.** `application test`
uses `--report-events=false`; `runner start` and `flows run` use
`--no-report-events`. Do not substitute one spelling for another.

**`collection run` uploads its run history either way.** The opt-out covers
analytics only — the upload is gated on a separate internal flag that
`--no-report-events` does not touch. What the flag does affect is git-native v3
collections specifically: it selects the execution engine that lets *their*
results upload, which is why the command's `--report-events` help text reads
"Upload results for git-native v3 collection runs. Analytics are sent by
default." Contrast `application test`, whose opt-out does cover both.

The exception is `postman init`, which the `bootstrap` skill runs. There
`--report-events` is opt-*in* (it gates one richer analytics row and needs a
login), and `init` declares no negated form — so `--report-events=false` on
`init` is rewritten to an option it does not have, and the command exits
non-zero with `unknown option`. Don't copy the opt-out onto `init`.

### Not declinable: client-events

Independently of any flag, the CLI emits a one-line "this command ran" event to
Postman's unauthenticated client-events collector. It does not depend on
`--report-events` and does not depend on being logged in, so
`--no-report-events` does not stop it. `postman collection run`,
`spec lint`, `workspace push` and `init` emit it in addition to the table
above, as do the `postman mock` subcommands and `postman performance run`.

The one thing that does suppress it: the collector is only wired for the US
region, and emission no-ops in other regions (EU included).

### MCP

Separately, **every route** configures the hosted Postman MCP server at
`mcp.postman.com`, so MCP tool calls made through any of them reach Postman
too — see [The MCP server config](#the-mcp-server-config). None of the CLI
flags above apply to that traffic; declining it means not installing the MCP
server.

Every route names its endpoint outright — `/mcp` for Claude Code, Cursor and
Codex, `/minimal` for Kimi Code and OpenCode. Don't reintroduce a `${POSTMAN_MCP_MODE:-...}`
placeholder to express the default: no route expands `${...}` inside an MCP URL,
so the whole segment ships literally and the request never reaches the intended
mode. `claude plugin list --json` reports the registered URL with the
placeholder still in the path, Cursor has no such plugin variable here, and the
Agent Plugins spec is explicit that only `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`
expand and never in a URL. If the mode ever needs to be configurable, resolve it
at build time or behind a stdio wrapper rather than in the URL string.

## The MCP server config

Each route has its own config file, so each can report itself in `X-Source` and
traffic can be attributed to the agent it came from:

```
mcp.claude-code.json        <- .claude-plugin/plugin.json  "mcpServers": "./mcp.claude-code.json"
mcp.cursor.json             <- .cursor-plugin/plugin.json  "mcpServers": "./mcp.cursor.json"
mcp.codex.json              <- .codex-plugin/plugin.json   "mcpServers": "./mcp.codex.json"
.kimi-plugin/plugin.json       inline — Kimi documents no path form
opencode/index.ts              OpenCode config hook — headers use package.json's version
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

## Changing a skill

1. Edit the file under `skills/<skill>/`.
2. Run `node scripts/build-manifest.js`.
3. Bump the version on every route that ships the change. Routes version
   independently — differing versions across routes are correct, not drift —
   so a bump means the three strings that one route owns: `version` in its
   manifest, plus `X-Plugin-Version` and `User-Agent` in its MCP config (for
   Kimi all three live in the manifest; for Codex the two headers sit under
   `http_headers`, not `headers`). OpenCode derives both header strings from
   its npm package version, so its release change updates only that version.
   Run the route validation and tests so the strings are checked before you
   commit. Don't skip the bump itself either: `claude plugin update` compares
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
frontmatter, where `name` matches the directory. Run the manifest script.

## Removing a skill

Delete `skills/<name>/`, then grep the rest of the repo for that name —
`grep -rn "<name>" README.md skills/ intent.md` — since other `SKILL.md`
files and this README can reference a skill by name in prose, not just in
frontmatter, and nothing catches a stale reference automatically. Fix or
remove what turns up, then run the manifest script.

## The bindings placeholder

`SKILL.md` may contain `{{POSTMAN_BINDINGS}}`. `postman init` replaces it with a
table of that repository's spec path, collections directory, CLI version, and
workspace id. Anything that consumes a skill without substituting it should leave
the marker alone rather than guess.

## License

Apache-2.0 — see [LICENSE](LICENSE).
