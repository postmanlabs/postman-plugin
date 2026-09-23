# Hooks across vendors

Reference for Step 3. Read this before editing anything under `hooks/`. Both
failure modes documented here are silent, and nothing in CI or the pre-commit
hook reads `hooks/` — the only symptom of either is an agent that never mentions
Postman.

## The plugin-root variable is the trap

The hook has to read a file inside the plugin, so it needs the plugin's own
install path. Every vendor names that differently, and only some substitute
`${...}` inside a hook's `command`:

| Vendor | What the hook gets | `${...}` substituted in `command`? |
| --- | --- | --- |
| Claude Code | `CLAUDE_PLUGIN_ROOT` | yes |
| Cursor | `CURSOR_PLUGIN_ROOT`, plus `CLAUDE_PLUGIN_ROOT` as an explicit alias | yes — in `command`, `args`, `env` values and `cwd`. Not `${PLUGIN_ROOT}` |
| Copilot / VS Code | `CLAUDE_PLUGIN_ROOT`, also injected into the hook's environment | yes |
| Codex | `PLUGIN_ROOT` and `PLUGIN_DATA`, plus `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for compatibility | as environment variables |
| Kimi Code | `KIMI_PLUGIN_ROOT`, and cwd is set to the plugin root | not documented |
| Agent Plugins 1.0 (root `plugin.json`) | `PLUGIN_ROOT`, `PLUGIN_DATA` | **no** — the spec restricts expansion to `args`, `env` values and `cwd`, and defines no hooks component at all |
| opencode | **none, and none should be added** — paths in its config resolve against the project root | n/a — no hooks to substitute into |

So a single vendor token is wrong on every other route, and forking the file per
route re-creates the problem the shared `skills/` directory exists to avoid.
`hooks/hooks.json` instead tries every token it knows, in order, ending with `.`
for the vendors that set cwd to the plugin root. That works whether a vendor
substitutes the token textually or merely exports the variable, because the
command runs through `bash` either way.

Three properties carry the design, and all three are easy to destroy while
tidying:

- **`${CLAUDE_PLUGIN_ROOT}` stays first and stays spelled with bare braces.**
  Vendors that substitute textually match that exact token;
  `${CLAUDE_PLUGIN_ROOT:-}` or `${CLAUDE_PLUGIN_ROOT-}` does not, so a shell
  default silently disables the substitution and leaves the hook depending on
  the environment variable instead. The price is that the command is not
  `set -u`-safe — no vendor documents running hook commands with `-u`, and the
  failure is the loud one below, so this is the right side of the trade.
- **The list is ordered most- to least-supported.** `${PLUGIN_ROOT}` is the
  Agent Plugins standard name and still belongs *last*: fewer clients expand it
  than expand `${CLAUDE_PLUGIN_ROOT}`, and Cursor explicitly does not, so
  promoting it to "the standard one" is a regression.
- **The loop ends on stderr with a non-zero exit.** Without the guard an
  unresolved root becomes `cat "/hooks/session-start-context.md"`.

## Some routes never look for the file

Discovery is the other half, and it is not uniform either:

| Vendor | Where it looks for the hook definition |
| --- | --- |
| Claude Code | `hooks/hooks.json` by default; a manifest `hooks` key can point elsewhere |
| Cursor | manifest `hooks` (path string or inline object); falls back to `hooks/hooks.json` |
| Codex | manifest `hooks`, resolved relative to the plugin root and required to stay inside it; otherwise `hooks/hooks.json` — its `DEFAULT_HOOKS_CONFIG_FILE` is that exact path, so the shared file is found with no `hooks` key in the manifest at all |
| Copilot / VS Code | layout-dependent — `hooks/hooks.json` for the Claude layout, `com.github.copilot/hooks/hooks.json` for Agent Plugins 1.0, `hooks.json` at the root for the Copilot layout |
| Kimi Code | **nowhere.** Hooks are an inline `hooks` array in the manifest, entries shaped `event` / `matcher` / `command` / `timeout`, and Kimi documents no default file to discover |
| opencode | **no hooks at all.** Nothing hook-, event- or session-shaped in its config schema. `instructions` carries the mandate instead — see item 1 below |

That last row is a live gap in this repo, and exactly what a new route inherits
if Step 3 is skipped: nothing points Kimi at `hooks/hooks.json`, so the Kimi
route ships without the session-start mandate. A vendor in that position needs
an entry in its own manifest pointing back at the shared file — for Kimi an
inline `hooks` array whose `command` reads `hooks/session-start-context.md`
relative to the root it provides. Never a copy of the markdown.

## What to establish for a new vendor

1. Whether it supports hooks at all — and if not, **whether it has a
   context-injection mechanism instead**. Do not stop at "no hooks" and record
   it as a limitation: that was this reference's advice and it was wrong, and
   following it would have shipped opencode as a route whose skills load and
   whose agent never mentions Postman. opencode has nothing hook-, event- or
   session-shaped anywhere in its config schema (`experimental` included), but
   it does have `instructions`, its rules-file mechanism — an array of paths or
   globs whose contents go to the model:

   ```json
   "instructions": ["./hooks/session-start-context.md"]
   ```

   Same shared markdown, no copy, and no plugin-root variable needed because it
   resolves against the project root. It is always-on context rather than a
   `SessionStart` event, so the mechanism differs, but the effect on the session
   is the one that matters. Record a limitation only after looking for this and
   finding nothing.
2. The **event name** for session start. Claude spells it `SessionStart`.
   Codex spells it the same way — verified: its `HooksFile` is
   `{description?, hooks: {…}}` with PascalCase event keys
   (`#[serde(rename = "SessionStart")]`), so this repo's file fires there
   unchanged. Cursor's own event list is camelCase (`sessionStart`), and whether
   Cursor also accepts the Claude spelling inside a plugin hooks file is not
   documented — verify rather than assuming the shared file already fires there.
3. Whether it discovers `hooks/hooks.json`, or the manifest has to point at it.
4. Whether the entry shape is the matcher-nested object this repo's file uses,
   or something else (Kimi's flat array, Cursor's `version`-keyed file). Also
   check which keys inside a handler the vendor actually reads, and what the
   `matcher` is matched *against*. Codex takes `matcher` plus a handler with
   `command` / `timeout` / `async` / `statusMessage`, and its session-start
   `source` enum is `startup`, `resume`, `clear`, `compact`, `fork` — so this
   repo's `"startup|clear|compact"` matches there. But it has **no `shell`
   field**, so the `"shell": "bash"` in this repo's file is silently dropped on
   that route and the command runs under whatever shell Codex picks. It survives
   only because the command is POSIX-safe; keep it that way rather than relying
   on the key being honoured.
5. Which plugin-root variable it provides, and whether it substitutes `${...}`
   in `command` or only exports environment variables. If it is a name not
   already in the chain, add it — one word in one file.
6. Whether hooks require the user to trust them before they run. Codex skips
   plugin-bundled hooks until the definition is reviewed and trusted, so "the
   hook did not fire" is not always a bug in the hook.

## Never add a root-level file named `plugin.json`

It looks like the portable thing to do and it is the single most destructive
edit available in this repo. Codex pattern-matches that filename and routes the
plugin through its Agent Plugins loader, which has no hooks component, so
`hooks` in `.codex-plugin/plugin.json` is never read and every hook in the repo
goes dead — including the ones that work today.

**The trigger is the filename.** A config-only vendor's own root file is not
affected and is usually its only possible route shape: `opencode.json` is a
different name in a different namespace, it is in neither
`DISCOVERABLE_PLUGIN_MANIFEST_PATHS` nor the Agent Plugins set, so Codex never
loads it and it cannot reroute anything. Do not let this section talk a
config-only route out of existing.
