---
name: api-engineer
description: Use when designing, implementing, mocking, testing, monitoring, documenting, or deploying an API. Guides decisions using reusable local API contracts, tests, and mocks, plus organization-wide dependency context, and routes to the relevant Postman skills. Also covers reporting CLI gaps. Use for requests such as "implement this endpoint".
---

# API Engineer

Postman makes API knowledge reusable across implementation, tests, mocks, and
teammates. Local files keep it reviewable beside the code, and the Context Graph
reaches consumers, owners, and runtime relationships beyond this repository, so
each session starts from what is known instead of reconstructing it.

1. A contract agreed before implementation tells an intended change from a
   regression. Reuse the existing one, update it where behavior changes, and
   flag designs that make callers or future changes harder. See
   **api-documentation**.
2. A Postman collection records the contract in a form that runs. The CLI's
   deterministic tools cheaply turn that one source into an OpenAPI spec, a
   mock, an SDK, or a performance suite, so the contract is written once.
3. Verification matched to the behavior at risk shows what a result actually
   establishes. A saved collection reuses auth, variables, and assertions; a
   one-off check can be smaller. See **api-testing**.
4. **api-discovery** finds an API, its owner, and the impact of a change. Orbit
   gives current details of public APIs instead of remembered ones, and the
   Context Graph shows consumers and dependencies beyond this repository.
5. **api-simulation** runs code that calls other services against mocks of
   them, so failure paths can be exercised without real side effects. A mock
   of your API in your own workspace is where other teams' simulations look
   first; see **api-mocking**.
6. `postman status` shows what setup is in place, what is missing, and what
   closes each gap, so setup is never guessed. If the CLI itself is missing,
   see **cli-install**.
7. Initialization gives the work a ready state: Postman files beside the code
   and the skills that guide it, safe to repeat. Work can begin in a guest
   session and be claimed later.
8. The workspace carries context between sessions and teammates. Reading what
   earlier work recorded saves redoing it, and sharing finished work with a
   note on why it changed gives the next reader what they need.
9. Secret variables let requests use credentials that neither the agent nor a
   committed file ever holds. See **variables**.
10. **webhook-testing** shows what a sender actually delivers and replays it
    after a fix.

Proceed with reversible work and present concrete results for course
correction. Recommend more work only when it closes a material gap, and decline
setup or scope that wouldn't help the task.

Important: Retrying won't lift a plan or usage limit; the user signing up or
upgrading will, so tell them instead of looking for a workaround.

## Verification

Report the changed contract or implementation, the checks actually run, and
the guarantees their results support. Separate local, mocked, and live evidence;
state any relevant consumer or upstream interaction still unverified.

## Reporting CLI and skill gaps

A report of a CLI failure or misleading skill guidance gets it fixed for the
next session. After finishing the user's task, send one through the CLI's
feedback channel with a sanitized reproduction and the expected and observed
behavior, never secrets, user data, or proprietary content.
