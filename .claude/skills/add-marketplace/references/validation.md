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
  than at marketplace review. Entries carry `spec` (not always `draft7` —
  opencode's schema is draft2020) and an optional `ref` for a schema that
  `$ref`s another, since ajv resolves nothing over the network. Where a vendor
  sets `additionalProperties: false` this job has real teeth: opencode's schema
  rejects `mcpServers`, `type: "http"`, a string `skills` and a `version` key,
  each of them a plausible copy-from-another-route mistake that nothing else
  here would catch.

A new route's JSON joins the `manifest` job's `git ls-files '*.json'` loop
automatically once tracked. SchemaStore's Claude Code schemas accept invalid
plugin names and unknown keys, which is why `claude plugin validate` runs
alongside them.

## The pre-commit hook

`.claude/hooks/validate-manifests.js` runs before any `git commit` in this repo
(a `PreToolUse` hook in `.claude/settings.local.json`, filtered with
`if: "Bash(git commit*)"`). Silent when clean; blocks the commit with an
explanation when not.

It discovers manifest routes by globbing `.*-plugin/plugin.json`, so a new
**manifest** vendor is covered the moment its manifest exists. **That is not
true for a config-only vendor**, and this reference used to claim there was
nothing to register at all. A route whose config is a file at the repo root
matches no such glob and drops silently out of the `X-Source` uniqueness
check — the one invariant nothing else in the repo verifies — so it needs its
own branch in the hook. Check that a new route actually appears in the hook's
output rather than assuming the glob caught it.

It checks four things:

1. Every tracked `.json` parses.
2. `manifest.json` is in sync (same as CI's `--check`).
3. Per route: `X-Plugin-Version` and `User-Agent` agree with the manifest's
   `version`, every route declares an `X-Source`, and no two routes share one.
   On a route with no `version` key the two header strings are checked against
   each other instead, since there is no manifest field to compare them to.
4. That the headers and MCP block are under the keys that vendor actually
   deserializes — `headers` vs `http_headers`, `mcp` vs `mcpServers`. Each wrong
   spelling is accepted silently at runtime and costs the route its attribution.

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
- **The header key** the vendor deserializes (`headers` vs `http_headers`). The
  wrong one is dropped silently and the traffic goes out unattributed.
- **Everything about hooks.** Neither CI nor the pre-commit hook reads `hooks/`.
  `scripts/check-hooks.sh` in this skill is the only check there is, and it only
  covers root resolution — not whether the vendor discovers the file at all, or
  spells the session-start event the way the file does. It also assumes every
  vendor *has* a plugin-root variable: for a config-only vendor there is none to
  pass, and naming one anyway produces a `FAIL` that reads like a regression
  when the honest answer is "not applicable".
- **Whether a route delivers the session-start mandate by some other
  mechanism.** A vendor with no hooks may still carry it through a rules or
  instructions file, and nothing here can tell the difference between that and a
  route that silently never mentions Postman.
