# Intent: next 5 skills

`api-builder` is removed. Ground truth for feature names, relationships, and
CLI subcommands below is [postman.com/llms.txt](https://www.postman.com/llms.txt)
and the Postman CLI docs, not memory.

Postman's own framing: "one platform spanning API design, testing, mocking,
monitoring, and load, run locally and in CI." Each skill below is one slice of
that sentence. None of them own "API development" broadly — that scope is
gone with api-builder.

This draft went through one adversarial pass. Its one real factual challenge —
"prove api-documentation is a real, distinct feature or kill it" — is resolved
below with a citation. The other four findings are fixes, folded in inline.

## Cross-skill invariants

These apply to all five; not repeating them per skill.

1. **`bootstrap` is a precondition, not a peer.** The other four assume a
   repo already has a resolved spec/collection path, an authenticated
   Postman CLI, and (if needed) a workspace id. They fail loudly and stop if
   `bootstrap` hasn't run — they never re-derive or guess these.
2. **One collection, one set of assertions.** CI, monitoring, and mocking all
   act on the *same* collection a human runs locally. None of them fork a
   parallel copy of the requests or the test scripts. If the assertions
   need to differ by environment, that's an environment variable, not a
   second collection.
3. **Cloud-visible or billable action requires explicit consent.** Publishing
   a mock publicly, creating a Monitor (scheduled, runs on Postman's
   infrastructure), publishing docs externally — all gated, same as the
   `api-builder` publish step was. Local/private stays the default.
4. **No invented facts.** Workspace id, alert destination, environment URL,
   product feature names — if it isn't in the repo, the CLI, or told to us,
   the skill states the gap and stops. (This draft violated its own rule
   once — see api-documentation below — and got called on it.)

---

## bootstrap

**Wraps:** `postman login` (auth) and `postman workspace` (validate/sync
local elements — this is what resolves spec path, collections dir, workspace
id), plus this repo's own `postman init` (per README) which fetches
`manifest.json` and writes the skill bindings.

**Intent:** the one-time (idempotent) setup every other skill depends on.

**Must have:**
- Detect + run `postman login` if unauthenticated — don't proceed silently
  without it.
- Idempotent: safe to run on an already-bootstrapped repo; detects partial
  state (CLI present, no workspace linked) instead of assuming all-or-nothing.
- Never fabricates a workspace id or spec path. Missing → reported, not
  guessed.
- **Scope, closed:** bootstrap wires up an *existing* repo/API only. It does
  not scaffold a new spec from an empty repo — that's a design decision, not
  a setup step, and doing both is how `api-builder`'s scope crept back in
  under a new name.

---

## mocking

**Wraps:** `postman mock start` (Mock Servers) — "create a mock server from
any collection or specification, locally or in the cloud, configure responses
and delays."

**Intent:** stand up a mock so a consumer can build against the contract
before the implementation exists, sourced from the spec/collection, not
hand-authored.

**Must have:**
- Mock responses come from the spec's examples or the collection's saved
  responses — never authored directly into the mock config. If examples
  don't exist yet, the skill's job is to add them to the spec/collection
  first, not invent mock-only fixtures that drift.
- Default to local. Cloud mock creation (public URL, counts against mock
  call quota) needs consent per invariant 3.
- **Staleness check, concrete:** record a hash of the spec/collection file at
  mock-generation time; before trusting an existing mock, recompute and
  compare. Mismatch → say so before use, don't silently serve stale examples.

---

## ci

**Wraps two distinct CLI invocations, kept distinct:** `postman collection
run` (functional/contract test) and `postman api check` (API Governance rule
check against Spec Hub rules). API Catalog is a separate backend that ingests
CI results on its own — this skill feeds it results by running these two
commands, it does not talk to Catalog directly and doesn't get to claim it as
a feature it "owns."

**Intent:** the same checks a human runs locally, on push/PR, failing the
build on any failure — of either kind.

**Must have:**
- Runs `postman collection run` and `postman api check` as two independent
  steps with **two independent fail states**. A governance rule violation
  and a failed request assertion are different problems; collapsing them
  into one pass/fail hides which one broke.
- Hard fail on any failed assertion or rule. No "report but pass."
- Secrets (API key, environment values) come from the CI provider's secret
  store, never written into the workflow file or the repo.

---

## monitoring

**Wraps:** `postman monitor run` (Monitors) — "scheduled checks against a
live endpoint with alerting on failure."

**Intent:** a time-based check against a long-lived deployed environment,
distinct from `ci`'s per-push check against a fresh build. Same collection,
different trigger and target.

**Must have:**
- Reuses the existing collection + environment; does not duplicate requests
  or assertions into monitor-only config.
- Target environment (which URL, prod vs staging) and alert destination are
  supplied by the user, never assumed — pointing a scheduled check at
  production is consent-gated per invariant 3.
- States the check-frequency tradeoff (cost vs. detection latency) instead of
  picking a number silently.
- **Trigger wording, tightened:** the skill's description must distinguish
  "on a schedule, against a deployed environment" from `ci`'s "on push/PR,
  against a fresh build" clearly enough that a model doesn't reach for the
  wrong one.

---

## api-documentation

**Wraps:** confirmed real, distinct feature (verified directly against
postman.com, not assumed): Postman "automatically generates API documentation
for any OpenAPI 3.0 definition, as well as for any collection," and publishes
it "alongside other public API artifacts in the Postman API Network" or "to
public domains." This is separate from **Documents** (freeform collaborative
notes) and from **Spec Hub** (the design/authoring surface) — confirmed, not
guessed.

**Intent:** keep the docs a consumer reads in sync with the contract that
actually ships, instead of a hand-maintained page that drifts.

**Must have:**
- Docs are generated from the spec/collection (descriptions, examples, auth),
  never hand-written in parallel. A field with no description is a gap to
  fill in the spec, not in the doc.
- Publishing externally (API Network or public domain) is consent-gated per
  invariant 3; regenerating locally is not.
- States which source it rendered from (spec vs. collection) when both
  exist, since they can disagree.
