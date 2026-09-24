# Agent instructions for this repo

## Keep README.md in sync with the skills that actually exist

`README.md`'s `## Layout` section and its "Adding a skill" / "Removing a
skill" sections describe `skills/` in prose. That prose does not update
itself when a skill is added, renamed, or deleted — it has already drifted
before (a `## Layout` line hardcoded five skill names and kept two of them
long after those skills were replaced).

Whenever a change to this repo adds, renames, or removes a directory under
`skills/`:

1. Re-read `README.md` and update anything that names a specific skill —
   don't leave an enumerated list of skill names in prose if the change
   makes it stale. Prefer phrasing that points at `skills/` itself over
   re-typing the list, so the next rename doesn't create the same problem.
2. Grep the whole repo for the old name before deleting or renaming a
   skill directory — `grep -rn "<old-name>" README.md skills/ intent.md` —
   since other `SKILL.md` files reference each other by name in prose
   (descriptions, Critical Rules, "see `<skill>`" pointers), not just
   through frontmatter or `manifest.json`. Fix every hit; a reference to a
   deleted skill fails silently, it doesn't error.
3. Run `node scripts/build-manifest.js` and commit the regenerated
   `manifest.json` alongside the skill change.

`intent.md` is a historical design record of how the current skill set was
planned, not living documentation — its old skill names are not bugs and
should not be "fixed" to match the current directory list.

## Version bumps happen only through a separate release

Don't bump `version` in `.claude-plugin/plugin.json` (or the matching
version fields in `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`,
`.kimi-plugin/plugin.json`, and the `X-Plugin-Version`/`User-Agent` headers in
`mcp.*.json`) as part of a content change. Those bump together only as their
own dedicated release commit/PR, decoupled from whatever skill or doc edit
prompted the release — bundling a version bump into an unrelated fix makes
the diff harder to review and conflates "what changed" with "what shipped."

## Anti-patterns to check for when writing or reviewing a skill

These came out of real review comments on specific skills, but the mistake
generalizes — check for it whenever you touch any `SKILL.md` in this repo,
not just the file the comment was originally about.

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
