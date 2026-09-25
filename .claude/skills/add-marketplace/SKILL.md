---
name: add-marketplace
description: Add a new vendor plugin route (marketplace) to this repo - Windsurf, Zed, Copilot, Gemini CLI, opencode, or any other agent that can be pointed at a skills directory, whether it loads a plugin manifest or only a project config. Use when asked to add, wire up, or onboard a new marketplace, vendor, plugin route, or agent target. Covers the manifest or config, the MCP config, the session-start hook, the CI schema check, and the README sections that do not update themselves.
argument-hint: <vendor-name>
disable-model-invocation: true
---

# Add a vendor plugin route

A "route" is one agent's way of loading the *same* `skills/` and `hooks/`
directories. Every route points back at them; none gets its own copy. Adding one
is five files' worth of edits plus a README pass, and most of the cost is in the
parts nothing validates.

Vendor to add: **$ARGUMENTS** (if that is empty, ask which vendor before doing
anything else).

## Work in a worktree

Put this work in its own git worktree before editing anything. A route touches
the same shared files every other route touches — `README.md`,
`.github/workflows/validate.yml`, `hooks/hooks.json`, `manifest.json` — so two
routes in one working tree interleave their edits and neither agent can tell
which changes are theirs. The local pre-commit guard compounds it: the guard
validates the whole tree, so a neighbour's half-finished edit blocks your commit
with an error that has nothing to do with your route.

## Step 0 — Get the vendor's real format first

The existing routes disagree on every structural key, because each vendor
specified its own. [references/vendor-formats.md](references/vendor-formats.md)
records what each one does — read it as evidence, never as a template.

Establish all eight of these from the vendor's schema, docs or source before
writing anything:

1. **Whether it has a plugin manifest at all.** This decides the shape of
   everything below.
   - **Manifest route** — a plugin manifest the vendor discovers by path
     (`.claude-plugin/`, `.cursor-plugin/`, `.kimi-plugin/`, `.codex-plugin/`).
   - **Config-only route** — no manifest format exists, and the vendor is
     configured by one file it owns at the repo root. opencode is this: its
     plugins are npm modules and its skills are scanned from directories, so
     `opencode.json`'s `skills.paths` and inline `mcp` block *are* the whole
     route. Steps 1 and 2 collapse into that one file, Step 5 usually has no
     install command, and there may be no `version` key anywhere.
2. The manifest or config path and filename.
3. The **exact shape** of the skills pointer. The routes here already cover
   implicit, string, array and object (`{"skills": {"paths": ["./skills"]}}`), so
   take the shape the schema defines rather than the closest one on that list.
4. Whether MCP config is a path reference or inline, plus the transport, server
   and header key spellings.
5. Whether it publishes a JSON Schema, which draft, and **whether that schema
   `$ref`s another** — ajv resolves nothing over the network, so Step 4 has to
   fetch those too.
6. Whether it accepts a `version` key at all. opencode's root config is
   `additionalProperties: false`, so one cannot be added and Step 2's version
   agreement has to hold between the two header strings alone.
7. Whether it supports hooks and how it finds them. If it does not, read Step 3
   before concluding the route ships without the mandate.
8. The install command for the README, or that there is none.

**Enumerate the schema's properties. Never conclude a key is absent because the
prose docs do not mention it.** The two disagree in both directions: opencode's
`skills.paths` is in its schema and not on its docs site, Codex's `plugin.json`
is in prose with no schema at all. Where they disagree, what the vendor's code
deserializes wins — for a vendor with public source, one grep of the struct
settles it.

If any of the eight cannot be established, stop and ask. A wrong key is ignored
at load time, so the route ships doing nothing.

## Step 1 — The manifest, or the config

Create `.<vendor>-plugin/plugin.json`, or the root config for a config-only
vendor. Take the *values* from `.claude-plugin/plugin.json` (name, displayName,
description, author, homepage, repository, license, keywords) and the
*structure* from Step 0. A config-only route carries pointers, not plugin
metadata, so most of those values have nowhere to go — do not invent keys to
hold them.

**A new route starts at `1.0.0`.** Routes version independently here, so the new
number has no reason to match anyone else's, and the route ships the whole skill
set on day one — there is no partial first release for a `0.x` to signal.

That version goes everywhere the route carries it: the manifest `version`, plus
`X-Plugin-Version` and `User-Agent` in Step 2. A route with no `version` key
carries it in those two headers alone.

## Step 2 — The MCP config

A new `mcp.<vendor>.json`, or an inline server block, per Step 0. Four things
must hold. CI checks none of them; the pre-commit guard checks the first three.

- **`X-Source` is `postman-<vendor>-plugin` and unique.** Postman's telemetry
  keys on it, so a reused value collapses two routes into one bucket — which
  reads exactly like an agent nobody uses.
- **`X-Plugin-Version` and `User-Agent` agree with the manifest `version`.**
  `User-Agent` is `postman-<vendor>-plugin/<version>`. A mismatch is accepted at
  runtime and files the traffic under a version never cut.
- **The server and header keys are the ones that vendor deserializes** —
  `mcpServers` for the manifest routes and `mcp` for opencode; `headers` for
  three routes and `http_headers` for Codex. The wrong spelling is dropped with
  no error, the server still connects, and every request goes out unattributed.
- **The URL ships literally**, with its mode segment. Never put `${...}` inside
  the URL; no route expands variables there, so the placeholder ships as-is.

`/mcp` and `/minimal` expose different tool surfaces. Ask which one this vendor
gets instead of defaulting.

## Step 3 — Hooks

`hooks/hooks.json` injects `hooks/session-start-context.md`, the block that
points a session at `postman:api-engineer`. Without it a route loads the skills
and the MCP server but nothing routes a session into them, so the plugin reads
as if it were not installed.

One shared file, same rule as `skills/`. There is no portable plugin-root
variable, so the command tries every vendor token it knows in order and falls
back to `.` for vendors that set the hook's cwd to the plugin root:

```bash
set +u; for r in "${CLAUDE_PLUGIN_ROOT}" "${CURSOR_PLUGIN_ROOT}" "${KIMI_PLUGIN_ROOT}" "${PLUGIN_ROOT}" .; do
  f="$r/hooks/session-start-context.md"; [ -r "$f" ] && { cat "$f"; exit 0; }
done
echo "postman-plugin: ... no plugin-root variable resolved (tried ...)" >&2; exit 1
```

Add this vendor's token to that list if it is not already there — never a second
hooks file, never a copy of the markdown. Some vendors also need their own
manifest to point at the shared file because they do not discover it; Kimi does
not, and currently ships without the mandate.

**A vendor with no hooks still gets the mandate.** Before recording "no hook
support" as a limitation, look for a context-injection mechanism: an always-on
instructions or rules file the vendor feeds to the model. Most agents have one,
it takes the same shared markdown, and it beats nothing. opencode supports no
hooks of any kind, but its `instructions` array lands the same mandate:

```json
"instructions": ["./hooks/session-start-context.md"]
```

That is always-on context rather than a `SessionStart` event, and it resolves
against the project root so it needs no plugin-root variable — but the effect on
the session is the one that matters.

Both failure modes here are silent and nothing in CI reads `hooks/`, so read
[references/hooks.md](references/hooks.md) before editing anything under
`hooks/`: it carries the per-vendor variable and discovery tables, the three
load-bearing properties of that command, and the six things to establish for a
new vendor.

## Step 4 — CI

`.github/workflows/validate.yml` runs three parallel jobs; the `schema` job is
the one a route touches.

- **Vendor publishes a schema** → add a `matrix.include` entry: `name`, `file`,
  `schema` (the vendor's raw URL, not a mirror, so a vendor tightening its
  schema fails here rather than at review) and `spec`.
- **It does not** → add the file to the parenthetical list in the comment above
  the job, with the reason there is no schema.

The `manifest` job's `git ls-files '*.json'` loop picks up the new file
automatically once it is tracked.

Three things about that job are not obvious, and each one cost a debugging pass:

- **`spec` is not always `draft7`.** Read the schema's own `$schema`; opencode's
  is draft/2020-12 and needs `--spec=draft2020`. A wrong `--spec` fails in ways
  that look like your file is bad.
- **An external `$ref` must be fetched too.** ajv resolves no reference over the
  network, so a schema that `$ref`s another fails with `can't resolve reference
  ... from id #` — an error about the *schema*, not about your file, which reads
  like a mystery. The matrix has no field for this yet: a route that needs one
  adds it (`ref`), a fetch step conditioned on it, and `-r` on the ajv call.
- **Build ajv's arguments as a bash array, and branch with `if`.** `-r <file>`
  has to arrive as two argv entries; a string built to split that way is
  unquoted at the call site, so it globs and word-splits too, which is
  shellcheck SC2086 and fails `actionlint` for the whole repo. And use
  `if [ -f ... ]; then`, never `[ -f ... ] && args+=(...)` — the latter is a
  false command under GitHub's `bash -e` when the file is absent, which aborts
  the step.

Run the ajv command locally rather than waiting for CI. Where a vendor sets
`additionalProperties: false` this check has real teeth: opencode's rejects
`mcpServers`, `type: "http"`, a string `skills` and a `version` key — every one
of them a plausible copy-from-another-route mistake that no other check here
would catch.

## Step 5 — README

`README.md` describes the routes in prose that does not update itself:

1. The **route table** near the top — one row (Route / How it gets the files /
   MCP config it reads / Reports itself as).
2. **`## Layout`** — the manifest, and the MCP config if separate.
3. **`## Installing`** — the vendor's install command, or fold it into an
   existing line (Cursor and Kimi already share `npx plugins add`).
4. **`## The MCP server config`** — a line in the mapping block, plus a bullet
   if the route introduces a *new* per-route difference (the `http_headers`
   bullet is there because Codex did).
5. **`## The session-start hook`** — only if the route adds a token to the chain,
   needs its own pointer at `hooks/hooks.json`, or supports no hooks at all.
6. Any sentence that **counts** routes. A number goes stale the moment another
   route exists; rephrase to drop the count rather than incrementing it.

## Step 6 — Verify

`$ROUTE_FILE` is the manifest or root config from Step 1.

```bash
actionlint .github/workflows/validate.yml
node -e "JSON.parse(require('fs').readFileSync('$ROUTE_FILE','utf8'))"
npx -y @anthropic-ai/claude-code plugin validate .
node .claude/hooks/validate-manifests.js && echo "manifests consistent"

# Root resolution for the session-start hook. Pass this vendor's plugin-root
# variable - or `none` for a config-only vendor, which has none and should not
# gain one. `none` says "not applicable" and still exercises the shared chain;
# naming a variable that does not exist reports a FAIL that reads like a
# regression.
.claude/skills/add-marketplace/scripts/check-hooks.sh <VENDOR>_PLUGIN_ROOT

# No other route's version may move: only your route's files may appear here.
# Scope by file, not by grepping the diff - an added `"version": "1.0.0"` line
# names no vendor and slips a text filter. Config-only routes match no
# `*plugin.json`, so name their root config explicitly.
git diff --name-only main -- '*plugin.json' 'mcp.*.json' opencode.json
```

If the vendor publishes a schema, run the `schema` job's ajv command against the
new file before pushing. [references/validation.md](references/validation.md)
covers what each of these checks and — more usefully — what none of them do.

## What not to do

- **Do not put a vendor-specific plugin-root variable in a hook command on its
  own**, fork `hooks/hooks.json`, or copy `hooks/session-start-context.md` into
  a route directory. Add the token to the shared chain; point at the shared file
  from the vendor's manifest.
- **Do not add a root-level file named `plugin.json`.** It looks like the
  portable thing to do and is the most destructive edit available here: Codex
  pattern-matches that filename and routes the whole plugin through its Agent
  Plugins loader, which has no hooks component, so every hook in the repo goes
  dead — including the ones that work today. The trigger is the filename, not
  root-level config in general: a config-only route's own file at the root is
  fine and is often the only shape available to it, since `opencode.json` is a
  different name in a different namespace that Codex never looks at.
- **Do not copy another vendor's manifest or MCP file wholesale.** `X-Source`,
  version, header key and URL mode are deliberate per-route differences; a copy
  breaks all four at once.
- **Do not bump any version.** `AGENTS.md` keeps bumps to a dedicated release
  PR. The new route's `1.0.0` is its starting value, not a bump; every other
  route's strings come out of your diff untouched, which Step 6 checks.
- **Do not run `node scripts/build-manifest.js` expecting a diff** *from the
  route itself*. `manifest.json` indexes the skill *files* and takes `plugin`
  from `.claude-plugin/plugin.json`'s name; adding a route changes neither. So
  if `--check` fails and you touched nothing under `skills/`, something else
  drifted — find out what.

  Adding a route often makes skill *prose* stale, because files under `skills/`
  name the routes. Reword them to key on the *property* (which endpoint a route
  uses) rather than on route names, so the next route does not re-create the
  staleness. That is a skill-file change: rebuild the manifest, and leave the
  bump to the release.
- **Do not add a `version` to `.claude-plugin/marketplace.json`.** It would
  override `plugin.json` and give that route a second source of truth.
- **Do not write a generator for these files.** A tool whose job is to keep them
  identical is wrong once versions are per-route.
- **Do not copy skill files into a route directory.** Point at `skills/`.
