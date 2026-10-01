# What is checked, and what is not

Reference for Steps 4 and 6.

## CI — `.github/workflows/validate.yml`

One parallel job per concern, so a failure names itself:

- **`skills`** — every `skills/*/SKILL.md` has frontmatter with `name` and
  `description`. Pure bash, no `setup-node` on purpose.
- **`manifest`** — `node scripts/build-manifest.js --check`, then every tracked
  `*.json` parses, then `node scripts/build-kimi-prompt.js --check` confirms Kimi's
  generated mandate is current and that Kimi will load it (Kimi only warns and
  drops a prompt it rejects), then
  `claude plugin validate .`. The manifest carries a
  `sha256` per file and `postman init` rejects a file whose bytes do not match,
  so a stale manifest fails on a user's machine rather than here; checking it on
  every push is much cheaper than diagnosing that.
- **`opencode`** — from `opencode/`: `npm ci`, the unit tests, the harness that
  installs the plugin as a user does (the clone's files and the one-line file
  under an isolated global config directory) and has the pinned OpenCode CLI
  load every skill, and a check that every skill has a routing eval case.
  OpenCode applies no version gate to a local plugin, so the minimum version
  is documented rather than enforced.
- **`schema`** — one matrix entry per official schema, fetched from the vendor's
  own source on every run, so a vendor tightening its schema fails here rather
  than at marketplace review. Entries carry `spec`, which is not always `draft7`
  — OpenCode's config schema is draft2020, and checks `mcp.opencode.json`
  because that file is a valid config fragment. Where a vendor sets
  `additionalProperties: false` this job has real teeth: OpenCode's schema
  rejects `mcpServers`, `type: "http"` and unknown server keys, each of them a
  plausible copy-from-another-route mistake that nothing else here would catch.

A new route's JSON joins the `manifest` job's `git ls-files '*.json'` loop
automatically once tracked. SchemaStore's Claude Code schemas accept invalid
plugin names and unknown keys, which is why `claude plugin validate` runs
alongside them.

ajv resolves nothing over the network, so a schema that `$ref`s another needs
the entry's `ref` set to that schema's URL; the job fetches it and passes `-r`.
One `ref` per entry — OpenCode's is the working example.

## The pre-commit guard

`.claude/hooks/validate-manifests.js` blocks a `git commit` that would leave the
routes disagreeing. Silent when clean; exits 2 with every problem at once when
not. It fails closed: a crash is caught and reported with exit 2, because a
hook that exits 1 is a non-blocking error and the commit would go through.

**It only runs where someone wired it up.** It is a `PreToolUse` hook filtered
with `if: "Bash(git commit*)"`, and it lives in `.claude/settings.local.json` —
machine-local, gitignored, and holding an absolute path. A fresh checkout
therefore has no guard at all until that entry is added by hand. Treat it as a
local convenience, not as an invariant the repo enforces.

Every route needs one line in `scripts/routes.js`, the registry the guard
reads. A **manifest** route goes in `MANIFEST_ROUTES`, keyed by its directory,
with any server or header key that differs from `mcpServers`/`headers`. The guard globs `.*-plugin/plugin.json` and
blocks on any directory missing from the table, rather than checking it against
spellings the vendor may not read. A **package** route matches no such glob and
goes in `PACKAGE_ROUTES`, giving its package manifest (the version source), the
MCP config its code reads, and the server key. The guard reports either file
missing, but nothing flags a route left out of the list: it just drops out of
the `X-Source` uniqueness check, the one invariant nothing else in the repo
verifies.

It checks:

1. Every tracked `.json` parses.
2. `manifest.json` is in sync (same as CI's `--check`).
3. The MCP servers are under the key that vendor reads — `mcpServers` for the
   manifest routes, `mcp` for OpenCode — in the manifest and in the file it
   points at. The other spelling is reported rather than skipped, because a
   route keyed wrongly has no servers to iterate and so passes every remaining
   check by doing nothing. An empty block is reported for the same reason.
4. The headers are under the key that vendor reads — `headers` or
   `http_headers`. The wrong spelling is accepted silently at runtime and costs
   the route its attribution.
5. Per server: `X-Plugin-Version` and `User-Agent` agree with the manifest's
   `version`, and `X-Source` is present and of the form `postman-<vendor>-plugin`.
   No two routes share an `X-Source`; servers within one route may.
   Where the route's format carries no `version` key, the two header strings are
   checked against each other instead — a route with neither is reported, since
   its traffic is filed under no version at all.

It deliberately does **not** fetch vendor schemas — network plus an `npx`
download per run is too slow for a commit gate. CI's `schema` job owns that, so
running the ajv command by hand is still worth it for a brand-new route.

Run it without committing:

```bash
node .claude/hooks/validate-manifests.js && echo "manifests consistent"
```

## What nothing checks

- **The URL mode segment** (`/mcp` vs `/minimal`) — a product decision about
  which tool surface the vendor gets.
- **Everything about hooks.** Neither CI nor the pre-commit guard reads
  `hooks/`. `scripts/check-hooks.sh` is the only check there is, and it covers
  root resolution only — not whether the vendor discovers the file at all, nor
  whether it spells the session-start event the way the file does. Pass `none`
  for a config-only or package vendor: it has no plugin-root variable, and the
  script reports `n/a` instead of a `FAIL` that reads like a regression.
- **Whether a route other than Kimi delivers the session-start mandate by some
  other mechanism.** A vendor with no hooks may still carry it through a rules
  or instructions file, and nothing here can tell that apart from a route that
  silently never mentions Postman. Kimi's `systemPromptPath` is the exception,
  checked by the `manifest` job.
