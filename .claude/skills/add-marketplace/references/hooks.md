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
| Factory Droid | `DROID_PLUGIN_ROOT`, plus `CLAUDE_PLUGIN_ROOT` for compatibility | yes — `${DROID_PLUGIN_ROOT}`, `$DROID_PLUGIN_ROOT`, `${CLAUDE_PLUGIN_ROOT}` and `$CLAUDE_PLUGIN_ROOT` |
| Kimi Code | `KIMI_PLUGIN_ROOT`, and cwd is set to the plugin root | not documented |
| Agent Plugins 1.0 (root `plugin.json`) | `PLUGIN_ROOT`, `PLUGIN_DATA` | **no** — the spec restricts expansion to `args`, `env` values and `cwd`, and defines no hooks component at all |
| OpenCode | **none, and none should be added** — the local plugin locates the clone's files from `import.meta.url` | n/a — it never reads `hooks/hooks.json` |
| Pi | **none** — the extension locates the tarball's files from `import.meta.url` | n/a — it never reads `hooks/hooks.json` |

So a single vendor token is wrong on every other route, and forking the file per
route re-creates the problem the shared `skills/` directory exists to avoid.
`hooks/hooks.json` instead tries every token it knows, in order, ending with `.`
for the vendors that set cwd to the plugin root. That works whether a vendor
substitutes the token textually or merely exports the variable, because the
command runs through `bash` either way.

Four properties carry the design, and all four are easy to destroy while
tidying:

- **`set +u` stays at the front.** Naming four variables when one is set is a
  `nounset` violation, so under `-u` the command aborts before reading
  anything — and the single-variable `cat` it replaced did not, making this a
  regression rather than an inherited limit. Measured: without `set +u` the
  chain fails under `-u` and `-eu` in bash, sh, zsh, dash and ksh, and `-u`
  also swallows the loud failure below. With it, all five pass on both paths.
- **`${CLAUDE_PLUGIN_ROOT}` stays first and stays spelled with bare braces.**
  Vendors that substitute textually match that exact token;
  `${CLAUDE_PLUGIN_ROOT:-}` or `${CLAUDE_PLUGIN_ROOT-}` does not, so a shell
  default silently disables the substitution and leaves the hook depending on
  the environment variable instead. `set +u` is what makes the bare form safe,
  so the two travel together — keep one without the other and the problem is
  back.
- **The list is ordered most- to least-supported.** `${PLUGIN_ROOT}` is the
  Agent Plugins standard name and still belongs *last*: fewer clients expand it
  than expand `${CLAUDE_PLUGIN_ROOT}`, and Cursor explicitly does not, so
  promoting it to "the standard one" is a regression.
- **The loop ends on stderr with a non-zero exit.** Without the guard an
  unresolved root becomes `cat "/hooks/session-start-context.md"`. Verified
  through Claude Code: a plugin with the markdown removed reports
  `exit_code: 1, outcome: "error"` and the message in `stderr`.

## The context itself must stay agent-neutral

`hooks/session-start-context.md` is one file read by every route that has a
context mechanism — Claude Code and Cursor through `hooks/hooks.json`, Codex
through its fallback to that same file, OpenCode and Pi through their own code,
and Factory Droid through `hooks/hooks.json`. Those last three name skills
without the `postman:` prefix, so each rewrites `` `postman:<skill>` `` to the
bare name: the two plugins in code, the hook with `sed` when
`DROID_PLUGIN_ROOT` is set. Droid's Skill tool answers
`Skill "postman:api-engineer" not found` otherwise. So it must
not name one vendor's machinery: "invoke it with the Skill tool" is an
instruction Codex and OpenCode cannot follow, and it reaches them verbatim.
Name the skill and let each agent use its own loading mechanism. A vendor that
needs different wording is a reason to fix the shared text, not to fork it.

## Which shell, and which OS

Claude Code runs a hook's `command` through `sh -c` on macOS and Linux, and on
Windows through Git Bash if installed or PowerShell if not. The `shell` field is
real and takes `"bash"` or `"powershell"`; this repo sets `"bash"`, which is
what keeps Windows on Git Bash. It is ignored if `args` is ever added, since
`args` switches to exec form and spawns the binary with no shell at all.

The command therefore has to be POSIX-safe rather than bash-specific. Measured
working in bash, sh, zsh, dash and ksh — dash matters most, being `/bin/sh` on
Debian and Ubuntu. Untested: busybox `ash`, and Windows itself.

One Windows caveat, before someone "fixes" it: a Windows box with no Git Bash
cannot run a shell-form hook at all, and no amount of POSIX tidiness changes
that. It is a pre-existing limit rather than something the vendor chain
introduced — the `cat` one-liner needed a POSIX shell just as much. Supporting
it means a separate PowerShell command to keep in step with this one.

## Some routes never look for the file

Discovery is the other half, and it is not uniform either:

| Vendor | Where it looks for the hook definition |
| --- | --- |
| Claude Code | `hooks/hooks.json` by default; a manifest `hooks` key can point elsewhere |
| Cursor | manifest `hooks` (path string or inline object); falls back to `hooks/hooks.json` |
| Codex | manifest `hooks`, resolved relative to the plugin root and required to stay inside it; otherwise `hooks/hooks.json` — its `DEFAULT_HOOKS_CONFIG_FILE` is that exact path, so the shared file is found with no `hooks` key in the manifest at all |
| Factory Droid | `hooks/hooks.json` at the plugin root, in the same `hooks`-wrapped shape as Claude Code. The command takes its own branch when `DROID_PLUGIN_ROOT` is set: it reads the mandate from there and strips the `postman:` prefix, so it doesn't depend on Droid's `CLAUDE_PLUGIN_ROOT` alias. A top-level event key is the shape of a user's `.factory/hooks.json`, not a plugin's |
| Copilot / VS Code | layout-dependent — `hooks/hooks.json` for the Claude layout, `com.github.copilot/hooks/hooks.json` for Agent Plugins 1.0, `hooks.json` at the root for the Copilot layout |
| Kimi Code | **nowhere.** Hooks are an inline `hooks` array in the manifest, entries shaped `event` / `matcher` / `command` / `timeout`, and Kimi documents no default file to discover |
| OpenCode | **no `hooks.json`.** Nothing session-shaped in its config schema; the local plugin pushes the mandate into the system prompt from its own hooks — see item 1 below |
| Pi | **no `hooks.json`.** Its extensions subscribe to events instead; the package's extension sets the mandate as a system-prompt section on `before_agent_start` |

The Kimi Code row is a live gap in this repo, and exactly what a new route inherits
if Step 3 is skipped: nothing points Kimi at `hooks/hooks.json`, so the Kimi
route ships without the session-start mandate. A vendor in that position needs
an entry in its own manifest pointing back at the shared file — for Kimi an
inline `hooks` array whose `command` reads `hooks/session-start-context.md`
relative to the root it provides. Never a copy of the markdown.

## What to establish for a new vendor

1. Whether it supports hooks at all — and if not, **whether it has a
   context-injection mechanism instead**. "No hooks" is not the end of the
   enquiry; stopping there ships a route whose skills load and whose agent never
   mentions Postman. A config-only vendor usually has a rules file for this —
   OpenCode's `instructions`, an array of paths whose contents go to the model,
   is one. A package route can do it in code: the OpenCode plugin reads the
   shared markdown and pushes it into the system prompt through
   `experimental.chat.system.transform` (v1) and `session.hook('context')` (v2).
   Either is always-on context rather than a `SessionStart` event, but the
   effect on the session is the one that matters. Record a limitation only
   after finding nothing.
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
affected, and neither is a package route's `package.json` in its own directory:
each is a different name, in neither `DISCOVERABLE_PLUGIN_MANIFEST_PATHS` nor
the Agent Plugins set, so Codex never loads it and it cannot reroute anything.
