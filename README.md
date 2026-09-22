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
| Codex plugin | `codex plugin marketplace add postmanlabs/postman-plugin` clones this repo and reads `.agents/plugins/marketplace.json`; `.codex-plugin/plugin.json` is the manifest it installs | Codex's plugin store |

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
.codex-plugin/plugin.json         the Codex plugin manifest
skills/<name>/SKILL.md            one skill per directory — see skills/ for the current list
manifest.json                     generated index of the skill files
scripts/build-manifest.js         regenerates it
```

Codex is the one route whose two files do not live in the same directory.
Codex looks for a plugin manifest at `.codex-plugin/plugin.json`,
`.claude-plugin/plugin.json`, then `.cursor-plugin/plugin.json` — but it looks
for a *marketplace* manifest at `.agents/plugins/marketplace.json`,
`.agents/plugins/api_marketplace.json`, `.claude-plugin/marketplace.json`,
then `.cursor-plugin/marketplace.json`. There is no
`.codex-plugin/marketplace.json` in that list, so putting one there would
silently do nothing and Codex would fall through to Claude's catalog instead.

Two more things Codex does by itself, so the manifest stays quiet about them:

- `skills/` and `hooks/hooks.json` are Codex's own default component paths.
  `.codex-plugin/plugin.json` restates `skills` for legibility but deliberately
  declares no `hooks` key — Codex's plugin validator rejects `hooks` as a
  manifest field, and it finds `hooks/hooks.json` without being told.
- `hooks/hooks.json` expands `${CLAUDE_PLUGIN_ROOT}`. Codex sets that variable
  alongside its own `PLUGIN_ROOT` for compatibility with existing plugins, so
  the shared hooks file works on both hosts unchanged. Don't "fix" it to a
  Codex-specific variable.

### Why Codex declares its MCP server inline instead of using `.mcp.json`

`.codex-plugin/plugin.json` is the one manifest that does *not* point at the
shared `.mcp.json`. Two things in that file don't survive Codex's plugin MCP
parser, and neither fails loudly:

- `"url": "https://mcp.postman.com/${POSTMAN_MCP_MODE:-mcp}"` — Codex does no
  shell-style variable expansion here, so the server would be configured with a
  literal `${POSTMAN_MCP_MODE:-mcp}` in its URL and fail at connect time, well
  after a clean install.
- `"headers"` — Codex's field is `http_headers`, and unknown keys are dropped
  silently rather than rejected, so `X-Source` and the version headers would
  just never be sent.

So Codex gets a static inline declaration pinned to `https://mcp.postman.com/mcp`
(the default the placeholder resolves to) with the headers under `http_headers`.
An inline `mcpServers` object replaces default `.mcp.json` discovery rather than
adding to it, so there's exactly one `postman` server, and the shared file stays
as-is for Claude Code, Cursor, and Kimi.

Do **not** "fix" this by adding an Agent Plugins `$schema` to `.mcp.json` or
switching its `type` to `streamable-http`. Those belong to Codex's Agent Plugins
format, which it selects only for a **root-level** `plugin.json` carrying an
`agent-plugins.org` schema URI. This repo has no such file, so Codex parses in
legacy mode, where `type: "http"` is explicitly accepted and a `$schema` key in
`.mcp.json` is rejected outright by Codex's own plugin validator.

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
