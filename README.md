# Postman for Agents

Postman's skills for coding agents.

The skill files in this repository are the single source of truth for every
plugin route below — each tool's manifest points back at the same `skills/`
directory rather than copying files into itself:

| Route | How it gets the files | Lands at |
| --- | --- | --- |
| Claude Code plugin | `/plugin marketplace add postmanlabs/postman-plugin` clones this repo | Claude's plugin dir |
| Cursor plugin | `.cursor-plugin/plugin.json` points at this repo's `skills/` dir | Cursor's plugin dir |
| Kimi Code plugin | `.kimi-plugin/plugin.json` points at the same `skills/` dir, and bundles the Postman MCP server | Kimi's plugin dir |
| Codex plugin | `codex plugin marketplace add postmanlabs/postman-plugin` clones this repo and reads `.agents/plugins/marketplace.json`; the portable `plugin.json` + `mcp.json` are the manifests it installs | Codex's plugin store |

The Postman CLI also has its own path for installing these skills, but it's
still being redesigned — don't treat it as settled or document it here until
it lands.

## Layout

```
.claude-plugin/marketplace.json   the marketplace Claude Code adds
.claude-plugin/plugin.json        the Claude Code plugin manifest
.cursor-plugin/plugin.json        the Cursor plugin manifest
.kimi-plugin/plugin.json          the Kimi Code plugin manifest
.agents/plugins/marketplace.json  the marketplace Codex adds
plugin.json                       the portable Agent Plugins manifest Codex loads
mcp.json                          the portable Agent Plugins MCP config
.codex-plugin/plugin.json         Codex's overlay on plugin.json — listing metadata only
skills/<name>/SKILL.md            one skill per directory — see skills/ for the current list
manifest.json                     generated index of the skill files
scripts/build-manifest.js         regenerates it
```

### The Codex route, and why it uses three files

Codex is the one route that doesn't keep its files in a single directory, and
it's worth knowing why before moving any of them.

**The marketplace file is not under `.codex-plugin/`.** Codex looks for a
marketplace manifest at `.agents/plugins/marketplace.json`,
`.agents/plugins/api_marketplace.json`, `.claude-plugin/marketplace.json`, then
`.cursor-plugin/marketplace.json`. There is no `.codex-plugin/marketplace.json`
in that list, so putting one there would silently do nothing and Codex would
fall through to Claude's catalog instead.

**The plugin manifest is the portable one, in the repo root.** Codex has two
plugin formats. It picks the portable [Agent
Plugins](https://github.com/agentplugins/agent-plugins-spec) format when a
root-level `plugin.json` carries an `agent-plugins.org` `$schema`, and its own
legacy format otherwise (`.codex-plugin/plugin.json`,
`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, in that order). This
repo ships the portable manifest, so in Agent Plugins mode Codex **hardcodes**
two component paths and ignores whatever a manifest says about them:

- skills come from `./skills`
- MCP servers come from `./mcp.json`

`mcp.json` is a different filename from the `.mcp.json` the other three routes
share, so both coexist with no collision and no duplicate server.

`.codex-plugin/plugin.json` survives as Codex's *overlay* on the portable
manifest. It contributes only the listing metadata (`interface`) plus the
`apps`/`hooks` paths — its `skills` and `mcpServers` keys are inert in this mode.
Without it, Codex would derive a default listing from the portable fields and
file the plugin under category `Other`.

Pin `$schema` to **1.0.0**. The spec has a 1.1.0, but Codex accepts only
`https://agent-plugins.org/schemas/1.0.0/…` and rejects anything else outright
with `unsupported Agent Plugins schema`.

### Why `mcp.json` restates the server instead of reusing `.mcp.json`

Beyond the filename being fixed, two things in the shared `.mcp.json` would not
have survived, and neither fails loudly:

- `"url": "https://mcp.postman.com/${POSTMAN_MCP_MODE:-mcp}"` — the Agent
  Plugins spec forbids clients from expanding placeholders or environment
  variables in `url` or headers, so the server would be configured with a
  literal `${POSTMAN_MCP_MODE:-mcp}` and fail at connect time, well after a
  clean install. `mcp.json` pins the URL to the value the placeholder resolved
  to.
- `"type": "http"` — the portable format's HTTP transport is `streamable-http`,
  and its server objects are closed, so `http` is not a spelling it accepts.

`mcp.json` also drops the `User-Agent` header the other routes send. `User-Agent`
is on Codex's client-owned header list and is stripped silently, so carrying it
would only be misleading; `X-Source` and `X-Plugin-Version` are sent normally.

Two things that need no per-host handling at all:

- `hooks/hooks.json` is Codex's default hooks path, and no manifest declares it —
  Codex's plugin validator rejects `hooks` as a manifest field and finds the file
  on its own.
- `hooks/hooks.json` expands `${CLAUDE_PLUGIN_ROOT}`. Codex sets that variable
  alongside its own `PLUGIN_ROOT` for compatibility with existing plugins, so the
  shared hooks file works on both hosts unchanged. Don't "fix" it to a
  Codex-specific variable.

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

## Changing a skill

1. Edit the file under `skills/<skill>/`.
2. Run `node scripts/build-manifest.js`.
3. Commit both. CI runs `--check` and fails if you forget step 2.

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
