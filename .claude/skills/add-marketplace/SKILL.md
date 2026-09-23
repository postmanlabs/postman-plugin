---
name: add-marketplace
description: Add a new vendor plugin route (marketplace) to this repo - Windsurf, Zed, Copilot, Gemini CLI, opencode, or any other agent that can be pointed at a skills directory, whether it loads a plugin manifest or only a project config. Use when asked to add, wire up, or onboard a new marketplace, vendor, plugin route, or agent target. Covers the manifest or config, the MCP config, the session-start hook, the CI schema check, and the README sections that do not update themselves.
argument-hint: <vendor-name>
---

# Add a vendor plugin route

A "route" is one agent's way of loading the *same* `skills/` and `hooks/`
directories. Every route points back at them; none gets its own copy. Adding one
is five files' worth of edits plus a README pass, and most of the cost is in the
parts nothing validates.

Vendor to add: **$ARGUMENTS** (if that is empty, ask which vendor before doing
anything else).

## Work in a worktree. Always.

Before editing anything, put this work in its own git worktree. This is not a
preference — a route touches the same four or five shared files every other
route touches (`README.md`, `.github/workflows/validate.yml`, `hooks/hooks.json`,
`manifest.json`), so two routes in one working tree interleave their edits and
neither agent can tell which changes are theirs. That has already happened here:
two routes were added in parallel, one in a worktree and one in place, and the
in-place one ended up with another session's uncommitted edits to tracked files
sitting on its branch. Untangling that costs more than the route did.

A worktree also keeps the local pre-commit guard honest — it validates whatever
is in the tree, so a neighbour's half-finished edit blocks your commit with an
error that has nothing to do with your route.

## Step 0 — Get the vendor's real format first

Do not infer the shape from the routes already here — they disagree on every
structural key, because each vendor specified its own.
[references/vendor-formats.md](references/vendor-formats.md) records what the
existing routes do and why each difference is deliberate. Then use the
`find-docs` skill (or the vendor's own schema URL) to establish, for this vendor:

1. **Whether it has a plugin manifest at all.** Do not assume it does — this is
   the question that decides the shape of everything below, and Step 1 reads as
   if the answer is always yes. There are two kinds of route:
   - **Manifest route** — a plugin manifest the vendor discovers by path
     (`.claude-plugin/`, `.cursor-plugin/`, `.kimi-plugin/`, `.codex-plugin/`).
   - **Config-only route** — no manifest format exists. The vendor is
     configured by one file it owns at the repo root, carrying pointers rather
     than plugin metadata. opencode is this: its plugins are npm modules in a
     `plugin` array and its skills are scanned from directories, so a repo of
     skills reaches it only through `opencode.json`, whose `skills.paths` and
     inline `mcp` block *are* the whole route. Steps 1 and 2 collapse into that
     one file, there is usually no install command for Step 5, and there may be
     no `version` key anywhere.
2. The manifest or config path and filename it looks for.
3. The **exact shape** of the skills pointer. Do not go in with a menu of
   expected shapes and pick the closest — the routes here already cover
   implicit, string, array *and* object (`{"skills": {"paths": ["./skills"]}}`),
   so assume the next one is a shape this list does not have. Read the schema's
   properties and take the shape it defines.
4. Whether MCP config is a path reference or inline, plus the transport and
   header key spellings.
5. Whether it publishes a JSON Schema (needed for Step 4), a `$schema` URL, and
   **whether that schema `$ref`s another schema** — ajv resolves nothing over
   the network, so Step 4 has to fetch those too.
6. Whether it accepts a `version` key at all. Not all do — opencode's root
   config is `additionalProperties: false`, so one cannot even be added — and
   Step 2's version agreement is unsatisfiable on a route that cannot carry one.
7. Whether it supports hooks and how it finds them — Step 3. A vendor with no
   hooks is **not** automatically a route without the mandate; read Step 3
   before concluding that.
8. The install command users will run (for the README), or that there is none.

**Enumerate the schema's properties directly. Never conclude a key is absent
because the prose docs do not mention it.** The docs and the schema disagree in
both directions: opencode's `skills.paths` is in its config schema but absent
from its docs site, and a `find-docs` pass over those docs says the pointer does
not exist and discovery is fixed-path only — which is wrong, and wrong in the
direction that makes you ask the user to choose between bad workarounds. Codex
is the mirror image: `plugin.json` documented in prose only, with no schema at
all. Where the two disagree, what the vendor's code actually deserializes wins,
and for a vendor whose source is public one grep of the struct settles what the
docs leave ambiguous.

If any of those cannot be established from the vendor's own docs, schema or
source, stop and ask rather than guessing: a wrong key is silently ignored at
load time, so the route ships doing nothing.

## Step 1 — The manifest, or the config

Create `.<vendor>-plugin/plugin.json` — or, for a **config-only** vendor, the
project config it reads at the repo root. Copy the *values* from
`.claude-plugin/plugin.json` (name, displayName, description, author, homepage,
repository, license, keywords), the *structure* from Step 0. A config-only route
carries pointers, not plugin metadata, so most of those values have nowhere to
go and that is correct — do not invent keys to hold them.

Pick the starting `version` deliberately. Routes version independently — this
repo treats differing versions across routes as correct, not drift — so a new
route starts at whatever is honest for it, usually the current version of the
skill set it ships.

## Step 2 — The MCP config

A new `mcp.<vendor>.json` or an inline `mcpServers` block, per Step 0. Four
things must hold; **CI checks none of them**, and the pre-commit hook catches
only the first two:

- **`X-Source` is `postman-<vendor>-plugin` and unique.** It is the dimension
  Postman's telemetry keys on; a reused value collapses two routes into one
  bucket, which reads exactly like an agent nobody uses.
- **`X-Plugin-Version` and `User-Agent` agree with the manifest `version`.**
  `User-Agent` is `postman-<vendor>-plugin/<version>`. A mismatch is accepted at
  runtime and files the traffic under a version never cut.
- **The header key is whatever that vendor deserializes** — `headers` for three
  routes, `http_headers` for Codex. The wrong one is dropped with no error, the
  server still connects, and every request goes out unattributed.
- **The URL ships literally**, with its mode segment. Never put `${...}` inside
  the URL; no route expands variables there, so the placeholder ships as-is.

`/mcp` and `/minimal` expose different tool surfaces. Ask which one this vendor
should get instead of defaulting.

## Step 3 — Hooks

`hooks/hooks.json` injects `hooks/session-start-context.md`, the block that
points a session at `postman:api-engineer`. Without it a route loads the skills
and the MCP server but nothing routes a session into them, so the plugin reads
as if it were not installed.

One shared file, same rule as `skills/`. There is no portable plugin-root
variable, so it tries every vendor token it knows in order and falls back to `.`
for vendors that set the hook's cwd to the plugin root:

```bash
for r in "${CLAUDE_PLUGIN_ROOT}" "${CURSOR_PLUGIN_ROOT}" "${KIMI_PLUGIN_ROOT}" "${PLUGIN_ROOT}" .; do
  f="$r/hooks/session-start-context.md"; [ -r "$f" ] && { cat "$f"; exit 0; }
done
echo "postman-plugin: ... no plugin-root variable resolved (tried ...)" >&2; exit 1
```

Adding a route means **adding that vendor's token to that list** if it is not
already there — never a second hooks file, never a copy of the markdown. Some
vendors also need their own manifest to point at the shared file because they do
not discover it (Kimi does not, and currently ships without the mandate).

**A vendor with no hooks is not a route without the mandate.** Before recording
"no hook support" as a limitation, look for a context- or rules-injection
mechanism — an always-on instructions file that the vendor feeds to the model.
Most agents have one, it takes the same shared markdown, and it is strictly
better than nothing. opencode supports no hooks of any kind, but its
`instructions` array points at the same file and lands the same mandate:

```json
"instructions": ["./hooks/session-start-context.md"]
```

That is not a hook — always-on context rather than a `SessionStart` event, and
it resolves against the project root so it needs no plugin-root variable — but
the effect on the session is the one that matters. Treating "no hooks" as the
end of the enquiry ships precisely the dead route this step exists to prevent.

Both failure modes here are silent and nothing in CI reads `hooks/`, so read
[references/hooks.md](references/hooks.md) before editing anything under
`hooks/`: it has the per-vendor variable and discovery tables, the three
load-bearing properties of that command, and the six things to establish for a
new vendor.

## Step 4 — CI

`.github/workflows/validate.yml` has three parallel jobs; two matter here:

- **Vendor publishes a schema** → add a `matrix.include` entry to the `schema`
  job: `name`, `file`, `schema` (the vendor's raw URL, not a mirror, so a vendor
  tightening its schema fails here rather than at review), `spec`, and `ref` if
  the schema references another one.
- **It does not** → add the file to the parenthetical list in the comment above
  the `schema` job, and say *why* there is no schema, the way the Codex entry
  does.

The `manifest` job's `git ls-files '*.json'` loop picks up the new file
automatically once it is tracked.

Three things about that job are not obvious, and each one cost a debugging pass:

- **`spec` is not always `draft7`.** Every entry was, until opencode's schema
  turned out to be draft/2020-12 (`--spec=draft2020`). Read the schema's own
  `$schema`; a wrong `--spec` fails in ways that look like your file is bad.
- **An external `$ref` must be fetched too.** ajv resolves no reference over the
  network, so a schema that `$ref`s another (opencode's `$ref`s
  `models.dev/model-schema.json` for its model union) fails with
  `can't resolve reference ... from id #` — an error about the *schema*, not
  about your file, which reads like a mystery. The matrix carries an optional
  `ref` and a conditional fetch step for exactly this.
- **Build ajv's arguments as a bash array, and branch with `if`.** `-r <file>`
  has to arrive as two argv entries; a string built to split that way is
  unquoted at the call site, so it also globs and word-splits, which is
  shellcheck SC2086 and fails `actionlint` for the whole repo. And use
  `if [ -f ... ]; then`, never `[ -f ... ] && args+=(...)` — the latter is a
  false command under GitHub's `bash -e` when the file is absent, which aborts
  the step.

Worth running the ajv command locally rather than waiting for CI: where a
vendor sets `additionalProperties: false` on its root object, this check has
real teeth. opencode's rejects `mcpServers`, `type: "http"`, a string `skills`
and a `version` key — every one of which is a plausible copy-from-another-route
mistake that no other check in this repo would catch.

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
   route exists; prefer rephrasing to drop the count over incrementing it.

## Step 6 — Verify

```bash
actionlint .github/workflows/validate.yml
node -e "JSON.parse(require('fs').readFileSync('.<vendor>-plugin/plugin.json','utf8'))"
npx -y @anthropic-ai/claude-code plugin validate .
node .claude/hooks/validate-manifests.js && echo "manifests consistent"
.claude/skills/add-marketplace/scripts/check-hooks.sh <VENDOR>_PLUGIN_ROOT

# No other route's version may move. Expect ONLY your own route's files here -
# scope it by file, not by grepping the diff text, since an added
# `"version": "0.1.0"` line names no vendor and slips a text filter.
git diff --name-only main -- '*plugin.json' 'mcp.*.json'
```

The last line applies only to a vendor that **has** a plugin-root variable.
Pass no argument for one that does not: a config-only vendor resolves paths
against the project root, so `check-hooks.sh OPENCODE_PLUGIN_ROOT` reports a
`FAIL` for a variable that does not exist and should never be added. That is a
correct chain test and a misleading verdict — "not applicable" is the real
answer.

If the vendor publishes a schema, run the `schema` job's ajv command against the
new file before pushing. [references/validation.md](references/validation.md)
covers what each of those checks and — more usefully — what none of them do.

## What not to do

- **Do not put a vendor-specific plugin-root variable in a hook command on its
  own**, and do not fork `hooks/hooks.json` or copy
  `hooks/session-start-context.md` into a route directory. Add the token to the
  shared chain; point at the shared file from the vendor's manifest.
- **Do not add a root-level file named `plugin.json`.** It looks like the
  portable thing to do and is the most destructive edit available here: Codex
  pattern-matches that filename and routes the whole plugin through its Agent
  Plugins loader, which has no hooks component, so every hook in the repo goes
  dead — including the ones that work today. **The trigger is the filename, not
  root-level config in general.** A config-only route's own file at the root is
  fine and is often the only shape available to it: `opencode.json` is a
  different name in a different namespace, Codex never looks at it, and nothing
  in opencode looks at `plugin.json`. Read this bullet as forbidding one
  filename, never as forbidding a root config file.
- **Do not copy another vendor's manifest or MCP file wholesale.** `X-Source`,
  version, header key and URL mode are deliberate per-route differences; a copy
  breaks all four at once.
- **Never bump another route's version.** Adding a marketplace changes nothing
  that the existing routes ship, so their `version`, `X-Plugin-Version` and
  `User-Agent` strings must come out of your diff untouched. A new route sets
  its own starting version (Step 1) and that is the only version this work
  touches. If you find yourself editing `.claude-plugin/plugin.json`'s version
  to add a route, stop — you are about to spend a release on every other route
  for a change none of them contain.
- **Do not run `node scripts/build-manifest.js` expecting a diff** *from the
  route itself*. `manifest.json` indexes the skill *files* and takes `plugin`
  from `.claude-plugin/plugin.json`'s name; adding a route changes neither. So
  if `--check` fails and you touched nothing under `skills/`, something else
  drifted — find out what.
  The trap here is that adding a route often makes skill *prose* stale, because
  files under `skills/` name the routes (which endpoint each is pinned to, which
  tool set follows). Fixing that wording is a skill-file change, which drags in
  the README's "Changing a skill" step 3 and its cross-route version bump — and
  that collides head-on with the rule above. Avoid the collision rather than
  resolving it: reword those files to key on the *property* (which endpoint a
  route uses) rather than on route names, which both fixes the staleness and
  stops the next route re-creating it. If a skill file genuinely has to change,
  land it as its own change with its own bump, not folded into the route PR.
- **Do not add a `version` to `.claude-plugin/marketplace.json`.** It would
  override `plugin.json` and give that route a second source of truth.
- **Do not write a generator for these files.** The repo makes this call
  explicitly: a tool whose job is to keep them identical is wrong once versions
  are per-route.
- **Do not copy skill files into the new route's directory.** Point at
  `skills/`.
