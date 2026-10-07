# Agent instructions for this repo

## Keep README.md and CONTRIBUTING.md in sync with the skills that actually exist

`CONTRIBUTING.md`'s `## Layout` section and its "Adding a skill" /
"Removing a skill" sections describe `skills/` in prose, and `README.md`
summarizes what the skills do. That prose does not update itself when a
skill is added, renamed, or deleted.

Whenever a change to this repo adds, renames, or removes a directory under
`skills/`:

1. Re-read `README.md` and `CONTRIBUTING.md` and update anything that
   names a specific skill — don't leave an enumerated list of skill names
   in prose if the change makes it stale. Prefer phrasing that points at
   `skills/` itself over re-typing the list, so the next rename doesn't
   create the same problem.
2. Grep the whole repo for the old name before deleting or renaming a
   skill directory —
   `grep -rn "<old-name>" README.md CONTRIBUTING.md skills/ hooks/ intent.md opencode/evals/` —
   since other `SKILL.md` files reference each other by name in prose
   (descriptions, Critical Rules, "see `<skill>`" pointers), and
   `hooks/session-start-context.md` names skills too, not just frontmatter
   or `manifest.json`. Fix every hit; a bare-name reference to a deleted
   skill fails silently. Only a `postman:<name>` one fails CI's `skills` job.
3. Give every added or renamed skill at least one case in
   `opencode/evals/cases.json`, and drop cases for a removed one. This
   reference errors too: CI's `opencode` job fails on a skill
   with no case or a case naming a skill that no longer exists.
4. Run `node scripts/build-manifest.js` and commit everything it
   regenerates alongside the skill change.

`intent.md` is a historical design record of how the current skill set was
planned, not living documentation — its old skill names are not bugs and
should not be "fixed" to match the current directory list.

## Keep the README's install commands runnable

Run every command you add to or change in `README.md`'s per-agent install
sections as written, in a fresh container with only Node, Git and that
agent's CLI, and keep it only if it works there. A command that runs only
inside an app, like Cursor's `/add-plugin`, can't be run there; say so in
the PR body.

- Where the README and the installer drive the same agent CLI (Claude Code,
  Codex, Factory Droid and Pi), the README names the same plugin ID,
  marketplace and source as `installer/src/hosts/`. Change them together.
- Give an agent this repo with a ref, such as
  `https://github.com/postmanlabs/postman-plugin/tree/main`, wherever it
  would otherwise resolve the bare URL to the latest GitHub release. Every
  stable installer release becomes this repo's latest GitHub release, so such
  an agent gets the installer's snapshot instead of `main`. Kimi Code can't
  even parse the tag, `@postman/postman-plugin@<version>`, because of its `/`.
- When a change alters anything a reader sees while installing (a command,
  ID, minimum version, prompt, exit code or printed next step), list it under
  a "Docs" heading in the PR body. The install page on learning.postman.com
  keeps its own copy, which this repo can't update.

## Minimum agent versions are measured

A minimum agent version, in `README.md`, `opencode/README.md` or the
installer, is the oldest release the route passes on. Find it by bisecting
that agent's releases, once per install route, and cite the bisect in the
PR. A changelog entry, the version CI pins and a number another doc states
are not minimums. A change to a route's manifest can move it.

## Check what a route delivers, not that it installed

When you change how a route delivers Postman (`hooks/`, a route manifest
under `.*-plugin/`, an `mcp*.json`, `manifest.json`'s format or order,
`opencode/src/`, `installer/src/pi-extension.ts` or `installer/src/hosts/`),
check that the route still delivers everything it did before:

- the request the agent sends its model lists every skill in
  `manifest.json` and carries the session-start mandate;
- the agent registers or connects to the Postman MCP server from the route's
  MCP config. The server's tools reach the model only after the user signs
  in, because Postman's server answers 401 until then.

An exit code, a `plugin list` entry or a file on disk shows none of this. A
hook can exit 0 and still deliver nothing: Codex skips a hook the user
hasn't trusted, Cursor rejects hook output that isn't JSON, and Kimi Code
never shows hook output to the model.

- Every route has a harness that checks this, and CI runs each one;
  `CONTRIBUTING.md`'s "Checking what each route delivers" says how to run
  them. All but Cursor's use a local stand-in model. Cursor's CLI talks only
  to Cursor's backend, so its harness needs a `CURSOR_API_KEY`. A new route
  gets a harness of its own, and a new way to deliver Postman gets an
  assertion in its route's harness.
- Read `.claude/skills/add-marketplace/references/hooks.md` before editing
  anything under `hooks/`.

## Version bumps happen only through a separate release

Don't bump `version` in `.claude-plugin/plugin.json` (or the matching
version fields in `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`,
`.kimi-plugin/plugin.json`, `.factory-plugin/plugin.json`, and the
`X-Plugin-Version`/`User-Agent` headers in `mcp.*.json` and `mcp.json`) as
part of a content change. A route's strings bump together, and only in
that route's own release commit/PR. Routes version independently, so a
release leaves every other route's strings alone. Bundling a version bump
into an unrelated fix makes the diff harder to review and conflates "what
changed" with "what shipped."

## Anti-patterns to check for when writing or reviewing a skill

Check every `SKILL.md` you write or review for these.

1. **Don't gate a low-stakes, reversible action behind user approval.**
   Filing `postman feedback`, proposing next steps, or any other action with
   no side effects on the user's own data doesn't need a "get approval
   before doing this" clause — that contradicts the plugin's own "never
   block on the human for reversible work" stance (see **api-engineer**'s
   Dos). Reserve approval language for genuinely consequential, hard-to-
   reverse actions (e.g. `workspace push`, `--push-strategy force-sync`).
2. **Don't reach for "cloud" as the word for "the Postman workspace."**
   Postman's own vocabulary is "workspace," not "cloud" — a workspace isn't
   a separate cloud environment, it's just the hosted side of the same
   entity. Say what the thing actually is ("the workspace," "a hosted
   workspace," "an existing workspace") rather than defaulting to "cloud" as
   a generic stand-in. (CLI flags like `--no-cloud` are literal flag names,
   not prose, and don't need to change.)
3. **Don't restate the same paragraph across two skills.** If two skills
   need the same guidance (e.g., when and how to file `postman feedback`),
   write it once in the skill that owns that concern and have every other
   skill point to it by name (`see **bootstrap**'s "..." section`) instead
   of copying the paragraph. A duplicated paragraph drifts the next time
   only one copy gets edited.
4. **Don't make a step mandatory up front when only some branches need it.**
   If a numbered process has a step (e.g., "authenticate") that only some
   of its later branches actually require, don't list it as an unconditional
   step before the branch point — fold it into the specific branch that
   needs it, gated on that branch's own condition. A reader shouldn't have
   to complete or dismiss a step that doesn't apply to the task they're
   actually doing.

## Anti-patterns in code that loads inside an agent, and in tests

1. **Feature-detect an agent API before calling it from code that loads
   inside the agent.** In the Pi extension and the OpenCode plugin, skip the
   feature when the API it needs is missing. Pi refuses every session when an
   extension throws while it loads.
2. **Start an install test from the state a new user has.** Don't create an
   agent's config directory, register its marketplace, trust its hook or
   disable its MCP server before the test runs. When a test needs such
   state, to stay offline or because CI can't install the agent, keep
   another case that starts without it; a unit test is enough.
