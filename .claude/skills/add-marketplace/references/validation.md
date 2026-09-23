# What is checked, and what is not

Reference for Steps 4 and 6.

## CI — `.github/workflows/validate.yml`

Three parallel jobs, so a failure names itself:

- **`skills`** — every `skills/*/SKILL.md` has frontmatter with `name` and
  `description`. Pure bash, no `setup-node` on purpose.
- **`manifest`** — `node scripts/build-manifest.js --check`, then every tracked
  `*.json` parses, then `claude plugin validate .`. The manifest carries a
  `sha256` per file and `postman init` rejects a file whose bytes do not match,
  so a stale manifest fails on a user's machine rather than here; checking it on
  every push is much cheaper than diagnosing that.
- **`schema`** — one matrix entry per official schema, fetched from the vendor's
  own source on every run, so a vendor tightening its schema fails here rather
  than at marketplace review. Entries carry `spec`, which is not always `draft7`
  — opencode's schema is draft2020. Where a vendor sets
  `additionalProperties: false` this job has real teeth: opencode's schema
  rejects `mcpServers`, `type: "http"`, a string `skills` and a `version` key,
  each of them a plausible copy-from-another-route mistake that nothing else
  here would catch.

A new route's JSON joins the `manifest` job's `git ls-files '*.json'` loop
automatically once tracked. SchemaStore's Claude Code schemas accept invalid
plugin names and unknown keys, which is why `claude plugin validate` runs
alongside them.

The matrix has no field for a schema that `$ref`s another, and ajv resolves
nothing over the network, so a route whose schema does that has to add one
(`ref`), a fetch step conditioned on it, and `-r` on the ajv call.

## The pre-commit guard

`.claude/hooks/validate-manifests.js` blocks a `git commit` that would leave the
routes disagreeing. Silent when clean; exits 2 with every problem at once when
not.

**It only runs where someone wired it up.** It is a `PreToolUse` hook filtered
with `if: "Bash(git commit*)"`, and it lives in `.claude/settings.local.json` —
machine-local, gitignored, and holding an absolute path. A fresh checkout
therefore has no guard at all until that entry is added by hand. Treat it as a
local convenience, not as an invariant the repo enforces.

It discovers manifest routes by globbing `.*-plugin/plugin.json`, so a new
**manifest** vendor is covered the moment its manifest exists. A **config-only**
route matches no such glob and needs an entry in the guard's
`CONFIG_ONLY_ROUTES` table — one line, giving the file and its server key.
Without it the route drops out of the `X-Source` uniqueness check, the one
invariant nothing else in the repo verifies. Check that a new route actually
appears in the guard's output rather than assuming the glob caught it.

It checks:

1. Every tracked `.json` parses.
2. `manifest.json` is in sync (same as CI's `--check`).
3. The MCP servers are under the key that vendor reads — `mcpServers` for the
   manifest routes, `mcp` for opencode — in the manifest and in the file it
   points at. The other spelling is reported rather than skipped, because a
   route keyed wrongly has no servers to iterate and so passes every remaining
   check by doing nothing. An empty block is reported for the same reason.
4. The headers are under the key that vendor reads — `headers` or
   `http_headers`. The wrong spelling is accepted silently at runtime and costs
   the route its attribution.
5. Per server: `X-Plugin-Version` and `User-Agent` agree with the manifest's
   `version`, every route declares an `X-Source`, and no two routes share one.
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
  for a config-only vendor: it has no plugin-root variable, and the script
  reports `n/a` instead of a `FAIL` that reads like a regression.
- **Whether a route delivers the session-start mandate by some other
  mechanism.** A vendor with no hooks may still carry it through a rules or
  instructions file, and nothing here can tell that apart from a route that
  silently never mentions Postman.
