---
name: application-testing
description: Sets up, runs, debugs, and interprets results from `postman application test` — the Postman layer that runs your Playwright tests, captures their network traffic, matches it against a collection contract, runs pm.test assertions, and publishes results to Application Inventory. Covers the Postman side of the integration only — not Playwright test authoring or Playwright failures unrelated to capture. Use when the user asks to "set up application testing," "test my application with Postman," "connect my Playwright tests to Postman," "capture network traffic from Playwright," "Playwright tests are running but nothing shows up in Postman," "why isn't application testing capturing anything," "exclude certain requests from capture," "generate a collection from my app's traffic," "set up application testing in CI," "what API coverage do my e2e tests have," "which APIs are my Playwright tests not hitting."
---

# Application Test

## Overview

**Requires a Playwright project in the repository.** Without Playwright e2e tests there is nothing to capture — Playwright is the only supported runner.

`postman application test` does not send its own requests. It:
1. Spawns your Playwright test command (e.g. `npx playwright test`)
2. The capture plugin intercepts network traffic and writes it as artifacts
3. The CLI reads those artifacts, matches each request against your collections, and runs any `pm.test` assertions saved in the matched items
4. Publishes results to Application Inventory in your Postman workspace

The question it answers: **did my app's actual HTTP calls conform to the collection contract?** Not "does this endpoint respond correctly" — for that, use `postman collection run`.

**Application Inventory** is where results are published — a Postman dashboard that records each run's Playwright test results alongside captured/matched/assertion counts, giving you a combined view of test health and API contract conformance across runs.

---

## Setup

**All `postman app` commands must be run from the repository root** — that is where `postman.config.cjs`, `.postman/resources.yaml`, and `postman/collections/` are expected to live.

**Before starting setup, verify a Playwright project exists in the repo.** Scan for a `playwright.config.ts`, `playwright.config.js`, or similar file anywhere in the tree:
```bash
find . -name "playwright.config.*" -not -path "*/node_modules/*"
```
If none is found, stop — `postman app test` has nothing to capture. Tell the user to set up a Playwright project first; this skill does not cover Playwright setup.

### Step 1 — Authenticate

```bash
postman login --with-api-key <api-key>
```

**Required to send any data to Postman** — results, Application Inventory registration, and run history all require authentication. Without it, the command still runs and prints locally but nothing is recorded in Postman.

### Step 2 — Link a workspace

A `.postman/resources.yaml` with a `workspace.id` must exist. If it is missing, the CLI exits with an error. Requires Step 1 — `postman init` needs you to be logged in to create and link a workspace:

```bash
postman init                          # interactive
postman init --visibility personal    # non-interactive (agents/CI)
postman init --visibility team        # creates a team workspace instead
```

### Step 3 — Install the capture plugin

`postman app test` checks for the capture plugin before running your tests and prompts to install it automatically if it is missing. You do not need to run a separate command.

To set it up in advance (or to re-run setup explicitly):

```bash
postman app setup-capture
```

Both paths install `postman-playwright` and wrap `playwright.config.ts/js` with `withPostman()`, auto-detecting npm / yarn / pnpm / bun from lockfiles.

To verify the config was wrapped correctly, `playwright.config.ts` should contain:

```ts
import { withPostman } from 'postman-playwright';
export default withPostman({ ... });
```

> **Legacy setup:** If the project uses `attachNetworkCapture()` in spec files instead of `withPostman()`, that is still supported — do not re-run `postman app setup-capture`. The CLI detects it automatically and uses the NDJSON capture path. Only migrate to `withPostman()` if the user asks to upgrade.
>
> Usage — wrap the `test` object at the top of each spec file:
> ```ts
> import { test as baseTest, expect } from '@playwright/test';
> import { attachNetworkCapture } from 'postman-playwright';
>
> const test = attachNetworkCapture(baseTest);
>
> test('my test', async ({ page }) => { ... });
> ```

### Step 4 — Create the config file

**If this is a first run with no existing collection, just run `postman app test` and let the wizard handle it.** Do not manually create `postman.config.cjs` — the wizard writes it for you and continues the run immediately without exiting.

The wizard asks:
1. Which collection to test against (or generate one from traffic)
2. Which command runs your tests — shows `package.json` scripts as options, or enter manually

**Do not manually write `postman.config.cjs` from scratch.** The wizard generates it correctly with the right `command` and `collections` wired up. Only edit an existing config — never create one by hand unless the file already exists and needs a targeted change.

When you do have a collection, bypass the wizard by pre-creating the config or passing flags:

```bash
postman app test \
  --command "npx playwright test" \
  --target-collection "postman/collections/Orders API"
```

Once `postman.config.cjs` is written with the correct `command` and `collections`, just run `postman app test` with no extra flags — the config is the source of truth. Passing `--command` or `--target-collection` alongside a correct config is redundant; flags only override config when you need a one-off change.

---

## Config File (`postman.config.cjs`)

Full shape — every field is optional:

```js
module.exports = {
  // Default command to run (overridden by --command flag)
  command: 'npx playwright test',

  // Where the CLI looks for capture artifacts (default: Playwright's outputDir, then pm-results/)
  networkLog: './pm-results',

  // Filters exclude matching network requests from analysis.
  // A request is dropped if it matches any rule below.
  filters: {
    urlPatterns: ['https://fonts.googleapis.com/**'],  // drop requests matching these URLs
    methods: ['OPTIONS'],                              // drop these HTTP methods
    headers: { 'x-internal-call': 'true' }            // drop requests with this header
  },
  // Alternatively, use the array form to scope rules to specific tests:
  // Each entry adds optional `target` (string/regex matched against "project › file › test title")
  // and/or `tags` (Playwright test tags, any-of). An entry with neither is global.
  // filters: [
  //   { target: 'checkout', urlPatterns: ['https://analytics.example.com/**'] },  // only in checkout tests
  //   { tags: ['@smoke'], methods: ['OPTIONS'] },                                  // only in @smoke-tagged tests
  //   { urlPatterns: ['https://fonts.googleapis.com/**'] }                         // global (no scope)
  // ],
  // Note: `tags` scoping requires withPostman() — not supported with legacy attachNetworkCapture.

  // Rewrite URLs before matching (e.g. strip staging prefix)
  // transformRequest(body, context) → return { url?, method? } with only the fields to override
  transformers: [
    {
      url: /https:\/\/staging\.example\.com\/(.*)/,
      transformRequest: (body, context) => ({
        url: `https://api.example.com/${context.url.match(/staging\.example\.com\/(.*)/)[1]}`
      })
    }
  ],

  // Named targets — each maps to a set of collections + optional environment
  targets: {
    default: {
      collections: ['postman/collections/Orders API'],
      environment: 'postman/environments/staging.env.yaml'
    },
    payments: {
      collections: ['postman/collections/Payments API'],
      environment: 'postman/environments/payments-staging.env.yaml'
    }
  }
};
```

**Select a target at runtime:**

```bash
postman app test --target payments
```

Each target is independent — only one runs per invocation. If the target name does not exist in config, the CLI finds no collections and falls through to the missing-collections prompt — it does not error. Make sure the target name matches exactly what is in `postman.config.cjs`.

**Override collections/environment for a single run without editing config:**

```bash
postman app test --target-collection "postman/collections/Orders API" --target-environment postman/environments/prod.env.yaml
```

`--target-collection` replaces the selected target's collections entirely for this run — config collections are ignored when this flag is present. `--target-environment` replaces the environment (last value wins if repeated). Neither changes the config file.

Both `--target-collection` and `collections` in config accept a **local path** or a **cloud UID**:
- Local path: `postman/collections/Orders API` — resolved relative to cwd
- Cloud UID: the collection's UUID from Postman — fetched directly from the cloud
- If a local path is not found but a cloud UID is mapped in `.postman/resources.yaml`, it falls back to the cloud automatically

---

## Key Flags

| Flag | When to use |
|---|---|
| `--command <cmd>` | Override the config's `command` for this run |
| `--target <name>` | Select a named target from config (default: `"default"`) |
| `--target-collection <path>` | Replace the target's collections for this run (repeatable; does not change config) |
| `--target-environment <path>` | Override environment without changing config |
| `--network-log <path>` | Point at a custom capture directory or a specific `.json`/`.ndjson` file |
| `--deployed-version <version>` | Tag results with app version; also reads `APP_DEPLOYED_VERSION` env var |
| `--capture-only` | Skip matching entirely; export captured traffic as a v3 collection organised by host — useful for bootstrapping a collection from real traffic |
| `--verbose` | Show unmatched requests and sandbox error details |
| `--report-events false` | Keep this run local; do not publish to Postman |

---

## Debugging

### `postman app setup-capture` fails

**No Playwright config found**
The CLI searches upward 4 levels and downward 3 levels for `playwright.config.ts/js/mts/cjs/mjs`. If it cannot find one, point at it explicitly:
```bash
postman app setup-capture --config apps/api/playwright.config.ts
```

**`--config` points at a wrong filename**
The file must be named exactly `playwright.config.ts`, `.js`, `.mts`, `.cjs`, or `.mjs`. A path like `playwright.setup.ts` is rejected.

**Package install failed**
The CLI runs your package manager (`npm`/`yarn`/`pnpm`/`bun` — detected from lockfiles) to install `postman-playwright`. If it fails (e.g. registry unreachable, permissions), install manually:
```bash
npm install --save-dev postman-playwright
```

**Config patch failed**
The automatic codemod could not rewrite your `playwright.config.*` (e.g. non-standard export pattern). Set it up manually:
1. `npm install --save-dev postman-playwright`
2. Add `import { withPostman } from 'postman-playwright'` to your config
3. Wrap the export: `export default withPostman(defineConfig({ ... }))`

### "No network traffic was captured"

The capture plugin is not writing artifacts. Check in order:

1. Are Playwright browsers installed? If tests fail with "Executable doesn't exist," check how the repo installs browsers — look for a `playwright install` step in `package.json` scripts, a Makefile, or CI config before running `npx playwright install` yourself.
2. Is `withPostman()` wrapping the Playwright config? Run `postman app setup-capture` if not.
3. Is Playwright writing test results to the expected dir? The CLI looks in: Playwright config's `outputDir`, then `test-results/` and `pm-results/` relative to the Playwright config directory, then the same relative to cwd — pass `--network-log <your-outputDir>` if artifacts land elsewhere.
4. Did Playwright crash before any tests ran? Fix the crash first — no captures are written until at least one test executes.
5. Are artifacts stale? The CLI ignores files older than command start time to avoid using a previous run's captures.

### Tests run but most requests show "not matched"

The CLI found captures but could not find matching collection items.

- Is the correct collection selected? Check `targets.default.collections` in config or pass `--target-collection` explicitly.
- Do the URLs actually match anything in the collection? Run with `--verbose` to see all unmatched URLs printed.
- Are URLs going through a proxy, staging prefix, or auth gateway? Add a `transformers` entry in config to rewrite them before matching.
- Are your collections in v3 format (YAML directory under `postman/collections/`)? Pass the directory path, not an individual file.

### "Config file has a syntax error"

The error output includes the file path and location. Fix the syntax in `postman.config.cjs`. CommonJS syntax only — `module.exports = { ... }`, not ES module `export default`.

### Upload fails (401 / 403 / 429 / 5xx)

Auth is checked lazily — **tests always run regardless of auth state**, but results are not recorded if the upload fails. Re-authenticate and re-run to get results stored in Postman.

Fix for 401: `postman login --with-api-key <api-key>`

### Assertions failing unexpectedly

Run with `--verbose` to see sandbox errors inline per request. Sandbox errors mean the `pm.test` script itself threw — check the test script in the collection item for runtime errors, not the API response.

### No workspace configured

If `.postman/resources.yaml` has no `workspace.id`, the CLI exits with:
```
[app:test] Setup failed: workspace id was not recorded in .postman/resources.yaml.
```
Fix: run `postman init` — it sets up the full Postman scaffolding including the workspace id.

### Captured lines skipped (oversized) — legacy path only

This warning only appears with the legacy `attachNetworkCapture()` setup, not with `withPostman()`.

If a yellow warning appears — `Skipped N NDJSON line(s) longer than N MiB` — a captured line exceeded the per-line parse limit (typically a large response body). Add `urlPatterns` or `methods` exclude filters in config to drop the offending traffic before it reaches the size check.

---

## Reading the Results

### Per-test output

Per-request icons:
- ✓ green = matched, no failed assertions (includes items with no test scripts)
- ✗ red = matched but assertions failed, or sandbox error
- – yellow = matched but no HTTP response received (assertions skipped)
- Unmatched requests only appear with `--verbose`

### Summary table

```
  collections          2
  tests               12
  requests captured   47  (3 filtered, 2 deduped)
  requests matched    38 matched  *  9 not matched
  assertions          54 total  *  51 passed  *  3 failed
```

- **requests captured**: raw count from capture files before any filtering
- **filtered**: dropped by `urlPatterns`/`methods`/`headers` filters in config
- **deduped**: same `METHOD + path` seen multiple times within one test; last occurrence wins
- **not matched** (yellow when > 0): requests the CLI could not find a collection item for — these do not run assertions
- **assertions**: only from matched requests

If `--report-events` is on (default) and upload succeeded, a `View results:` URL is printed linking to the Workflows tab in Application Inventory.

### Exit code

The CLI exits with the **test runner's exit code** (Playwright's), not the Postman assertion pass/fail count. A run where Postman assertions fail but all Playwright `expect()` calls pass will exit 0. If you need CI to fail on Postman assertion failures, check the summary table output or the published results.

---

## Bootstrapping a Collection from Real Traffic

### First-run interactive generation (recommended)

When `postman app test` finds no collections configured, it prompts:

```
Which Postman Collection tests your application's APIs?
  ❯ Generate a collection from my test traffic
    <existing collections listed here>
```

Choosing **Generate** runs the test command, captures the network traffic, builds a v3 collection organised by host and endpoint, saves it to `postman/collections/application-api-tests/`, writes that path into `postman.config.cjs` under `targets.default.collections`, and immediately runs assertions against it — all in one step. No second run needed.

**Agents:** prefer the interactive path — pipe a newline to select Generate, which writes a correctly wired `postman.config.cjs` in one step:
```bash
printf '\n' | postman app test
```
Only fall back to `--capture-only` if the environment truly cannot accept piped input — but then you will need to manually add the generated collection path to `postman.config.cjs`.

### `--capture-only` flag

Skips collection matching entirely and just writes the captured traffic as a v3 collection:

```bash
postman app test --capture-only
# output goes to pm-results/captured/ by default
# use --output <path> to write elsewhere
```

No assertions are run. Unlike the interactive generation flow, this does not update `postman.config.cjs` or run the analysis pipeline.

**Path difference:**
| Mode | Output path |
|---|---|
| Interactive generate | `postman/collections/application-api-tests/` — inside tracked collections, picked up by git sync |
| `--capture-only` | `pm-results/captured/` — outside tracked collections, a staging area to review before committing |

---

## Critical Rules

1. **`postman application test` captures traffic; it does not drive requests.** The test runner (Playwright) drives the app; this command observes and asserts. If no test runner is running, nothing is captured.
2. **"not matched" is not a test failure — it is a coverage gap.** Requests the CLI cannot find in a collection run no assertions. A high not-matched count means the collection is incomplete for the traffic the app generates.
3. **Transformers run before matching, not before capture.** The raw URL is stored; the transformer rewrites it for the matching step only. Use this to normalise staging/prod URL differences without losing the original for debugging.
4. **Results are published per run.** Each invocation creates a new entry in Application Inventory. Pass `--report-events false` for dry runs or local debugging you do not want recorded.

## Anti-patterns

- **Do not pre-create `postman.config.cjs` with empty `collections: []`** — it triggers the interactive collection prompt just the same as having no config. Only pre-create the config when you already have a collection path to put in it.
- **Do not use `--capture-only` when the wizard can run** — `--capture-only` puts the collection in `pm-results/captured/` and requires manual config setup. The interactive wizard (`printf '\n' | postman app test`) generates the collection and wires the config correctly in one step.
- **Do not run `postman app init`** — it is deprecated. Use `postman app test` directly; it runs the same wizard on first run.
- **Do not combine `--capture-only` with `--target-collection`** — `--capture-only` skips collection matching entirely; passing a collection alongside it has no effect and signals a misunderstanding of the mode.

## Verification

State captured / matched / not-matched / assertion counts from the summary table. Note whether results were published to Postman (`View results:` URL present) or kept local. If debugging a "not captured" issue, confirm which capture format was detected (Playwright JSON report or legacy NDJSON) and which directory the CLI scanned.
