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

**Before starting setup, verify a Playwright project exists in the repo.** Check for a config file or `@playwright/test` in package dependencies:
```bash
find . -name "playwright.config.*" -not -path "*/node_modules/*"
grep -r "@playwright/test" package.json packages/*/package.json 2>/dev/null
```
If neither is found, stop — `postman app test` has nothing to capture. Tell the user to set up a Playwright project first; this skill does not cover Playwright setup.

### Step 1 — Authenticate

```bash
postman login --with-api-key <api-key>
```

**Required to send any data to Postman** — results, Application Inventory registration, and run history all require authentication. Without it, the command still runs and prints locally but nothing is recorded in Postman.

### Step 2 — Link a workspace

A `.postman/resources.yaml` with a `workspace.id` is needed to upload results (default behaviour). If it is missing:

- **In a TTY**: the CLI runs an interactive setup — create a new workspace or connect an existing one.
- **Outside a TTY / CI**: the CLI prints guidance and exits. The workspace must be set up locally first, then `.postman/resources.yaml` committed. Load the `bootstrap` skill for the full workspace setup flow.

To skip workspace setup entirely (results kept local only):
```bash
postman app test --report-events false
```

### Step 3 — Install the capture plugin

Check whether the capture plugin is already set up before doing anything:
```bash
postman app setup-capture --dry-run
```
This shows the current state and what would be installed or patched — no files changed. If everything is already in place, skip this step entirely.

If setup is needed, apply it:
```bash
postman app setup-capture --yes
# with a non-default playwright config location:
postman app setup-capture --yes --config apps/web/playwright.config.ts
```
Outside an interactive terminal, the command exits with code 2 unless `--yes` is passed.

`postman app test --yes` also installs and patches automatically as part of the run — so this step is only needed if you want to set up capture explicitly before the first test.

If the automatic patch fails (e.g. non-standard export pattern), set it up manually:
```bash
npm install --save-dev postman-playwright
```
Then edit `playwright.config.ts`:
```ts
import { withPostman } from 'postman-playwright';
import { defineConfig } from '@playwright/test';

export default withPostman(defineConfig({ ... }));
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

### Step 4 — Run the command

Outside an interactive terminal, setup never prompts. What you need to provide:

**Command** — the CLI defaults to `npx playwright test` when a `playwright.config.*` is found and no command is configured. Check `package.json` scripts for a more specific Playwright script (e.g. `npm run test:e2e`) and confirm with the user which one to use.

**Collection** — check what's available before deciding:
```bash
ls postman/collections/
```
- Collections exist → present them to the user, confirm which to use, pass `--target-collection "postman/collections/<name>"`
- No collections → use `--yes` or `--generate-collection` to generate one from traffic (saved to `postman.config.cjs` automatically)

**Before running** — verify the app is reachable. `postman app test` spawns Playwright, which drives the live app; if the servers aren't up, tests fail immediately and nothing is captured. Check whether `webServer` in `playwright.config.*` starts them automatically. If not, start them first.

**Typical first run (no config yet):**
```bash
postman app test --yes                                        # uses npx playwright test default, generates collection
postman app test --yes --command "npm run test:e2e"           # custom command, generates collection
postman app test --target-collection "postman/collections/Orders API"   # use existing collection, default command
```
`--yes` also installs/patches the capture plugin if needed.

**Config already exists** — just run:
```bash
postman app test
```
The config is the source of truth. Pass flags to override values for a single run without editing it:
```bash
postman app test --command "npx playwright test --project=chromium"
postman app test --target-collection "postman/collections/Payments"
```

**`--capture-only`** — skips collection matching entirely and writes captured traffic as a v3 collection to `pm-results/captured/` (use `--output <path>` to write elsewhere). No assertions run, config is not updated. Use this only to stage and review traffic before committing a collection manually.

---

## Config File (`postman.config.cjs`)

The generated `postman.config.cjs` includes comments explaining every field — read it for the full reference. It stays current with the CLI version installed in the repo.

To edit config for common needs:
- **Change the test command** — update `command`
- **Add or change a collection** — update `targets.default.collections`
- **Exclude noisy requests** — add `filters` (urlPatterns, methods, headers)
- **Rewrite URLs before matching** — add `transformers`
- **Multiple named environments** — add entries under `targets`

A **target** is a named set of collections + optional environment. The `default` target is used when no `--target` flag is passed. Override for a single run without editing config:
```bash
postman app test --target <name>
postman app test --target-collection "postman/collections/Orders API"
postman app test --target-environment postman/environments/prod.env.yaml
```

---

## Key Flags

If unsure about any command's options or behavior, run `--help` on it:
```bash
postman app test --help
postman app setup-capture --help
```

---

## Debugging

Read the CLI error output first — it names the specific failure and what to fix. Two scenarios where the output alone is not enough:

### "No network traffic was captured"

The CLI doesn't diagnose why. Check:

1. **Browsers not installed** — if tests fail with "Executable doesn't exist", run `npx playwright install` (check `package.json` scripts or CI config for how the repo installs them).
2. **`withPostman()` not wrapping the config** — run `postman app setup-capture --yes` to patch it.
3. **Artifacts in a non-default directory** — pass `--network-log <path>` if Playwright's `outputDir` is custom.

### Tests run but requests show "not matched"

Run with `--verbose` to see the unmatched URLs. Then:

- Wrong collection selected — check `targets.default.collections` in config or pass `--target-collection`.
- URLs have a staging prefix or proxy path — add a `transformers` entry in `postman.config.cjs` to rewrite them before matching.

---

> **Note — Exit code:** The CLI exits with the **test runner's exit code** (Playwright's), not the Postman assertion pass/fail count. A run where Postman assertions fail but all Playwright `expect()` calls pass will exit 0. If you need CI to fail on Postman assertion failures, check the summary table output or the published results.

---

## Critical Rules

1. **`postman application test` captures traffic; it does not drive requests.** The test runner (Playwright) drives the app; this command observes and asserts. If no test runner is running, nothing is captured.
2. **`not matched` is not a test failure — it is a coverage gap.** Requests the CLI cannot find in a collection run no assertions and do not affect the exit code. A high not-matched count means the collection is incomplete for the traffic the app generates.
3. **Transformers run before matching, not before capture.** The raw URL is stored; the transformer rewrites it for the matching step only. Use this to normalise staging/prod URL differences without losing the original for debugging.
4. **Results are published per run.** Each invocation creates a new entry in Application Inventory. Pass `--report-events false` for dry runs or local debugging you do not want recorded.

## Anti-patterns

- **Do not use `--capture-only` when `--yes` or `--generate-collection` can run** — `--capture-only` puts the collection in `pm-results/captured/` and requires manual config setup. `postman app test --yes` (or `--generate-collection`) generates the collection, tests with it immediately, and saves it to config when no collection is already configured.
- **Do not run `postman app init`** — it is deprecated. `postman app test` runs the same setup on first use.
- **Do not combine `--capture-only` with `--target-collection`** — `--capture-only` skips collection matching entirely; passing a collection alongside it has no effect and signals a misunderstanding of the mode.

## Verification

State captured / matched / not-matched / assertion counts from the summary table. Note whether results were published to Postman (`View results:` URL present) or kept local. If debugging a "not captured" issue, confirm which capture format was detected (Playwright JSON report or legacy NDJSON) and which directory the CLI scanned.

Postman docs: https://learning.postman.com/docs/postman-cli/postman-cli-application/#postman-app-test
