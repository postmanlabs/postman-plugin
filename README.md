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

The Postman CLI also has its own path for installing these skills, but it's
still being redesigned — don't treat it as settled or document it here until
it lands.

## Layout

```
.claude-plugin/marketplace.json   the marketplace Claude Code adds
.claude-plugin/plugin.json        the Claude Code plugin manifest
.cursor-plugin/plugin.json        the Cursor plugin manifest
.kimi-plugin/plugin.json          the Kimi Code plugin manifest
skills/<name>/SKILL.md            one skill per directory — see skills/ for the current list
manifest.json                     generated index of the skill files
scripts/build-manifest.js         regenerates it
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

## Data sent to Postman

Some Postman CLI commands these skills run report events and results to Postman
by default. Each has its own opt-out flag — they are not spelled the same, so
copy the one for the command you're running:

| Command | Sent by default | Opt out with |
| --- | --- | --- |
| `postman application test` | Run results upload to Postman after each run | `--report-events=false` |
| `postman runner start` | Runner analytics | `--no-report-events` |
| `postman flows run` | Flow run analytics | `--no-report-events` |

Separately, the Kimi manifest and `.mcp.json` configure the hosted Postman MCP
server at `mcp.postman.com`, so MCP tool calls made through that route reach
Postman too. The Claude Code and Cursor routes ship skills only.

## Changing a skill

1. Edit the file under `skills/<skill>/`.
2. Run `node scripts/build-manifest.js`.
3. Bump the version — see [Releasing](#releasing).
4. Commit all of it. CI runs `--check` and fails if you forget step 2.

Step 2 is not optional — `manifest.json` carries a `sha256` per file, and a
stale manifest silently drifts from what the files actually contain instead
of failing loudly.

## Releasing

`.claude-plugin/plugin.json` declares a `version`, and that string is the only
thing `claude plugin update` compares. An install is cached at a version-keyed
path, so a release that changes files without changing the version reports
"already at the latest version" and delivers nothing. Bump it on every release
that users should receive — this repo has shipped empty updates for exactly
this reason before.

The version lives in three places and they move together:

```
.claude-plugin/plugin.json    version
.cursor-plugin/plugin.json    version
.kimi-plugin/plugin.json      version, X-Plugin-Version, User-Agent
```

`.mcp.json` carries the same string in its `X-Plugin-Version` and `User-Agent`
headers. `marketplace.json` deliberately declares no version — it would
override `plugin.json` and give the repo a second source of truth.

Semantic versioning: a breaking change to a skill's contract is major, a new
skill is minor, and a wording or bug fix is patch.

TODO: none of this is enforced. Nothing fails a PR that changes `skills/`
without bumping the version, and nothing catches the six strings drifting
apart — `.kimi-plugin/plugin.json` sat at 1.0.0 while three other surfaces
said 2.0.0. Worth adding to `validate.yml`: a sync check across all six
spots, a PR gate requiring a semver-greater version when shipped files
change, and a `scripts/bump-version.js` so the bump is one command instead
of six edits. `claude plugin validate .` would also catch manifest schema
errors the current JSON.parse loop cannot.

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
