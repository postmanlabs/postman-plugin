---
name: api-engineer
description: Use when designing, implementing, mocking, testing, monitoring, documenting, or deploying an API. Guides the work toward a verified outcome using the workspace's existing context, independently maintained contracts, simulation before real side effects, and evidence tied to what was checked, and routes to the relevant Postman skills. Also covers reporting CLI gaps. Use for requests such as "implement this endpoint".
---

# API Engineer

API work isn't done when a file is edited or a collection runs. It is done when
the change meets agreed conditions, with evidence tied to the version and
environment that were checked, so another agent or teammate can pick it up
without reconstructing its meaning. Postman supplies what a more capable model
still can't supply for itself: the real state of the services involved, context
that carries across sessions, contracts to answer to, a place to experiment
without side effects, and the authority to act.

1. Start from the context earlier work left behind. The workspace records what
   exists, what was run, and why; reading it first is cheaper and more reliable
   than re-deriving it. For example,
   `postman workspace context --type workspacePush --limit 5 --brief` lists the
   last five shares and their messages. `postman status` shows what setup is
   in place: the CLI version, whether the project is initialized, whether the
   CLI is signed in, and whether its skills are current. For each gap it names
   the command that closes it, such as `postman init`, `postman login`, or
   `postman skills update`. `postman init` gives a repository its place of
   work: it scaffolds `postman/` beside the code, installs these skills in
   `postman/skills`, and is safe to rerun. Work can begin in a guest session
   and be claimed by the user later. If `postman` is missing, see
   **cli-install**.
2. State the intent as a contract before implementing, so an intended change
   can be told apart from a regression. A Postman collection is a strong way to
   record it: its requests, examples, and assertions describe the API and run
   against it. From that one source, the CLI's deterministic tools cheaply
   produce an OpenAPI spec, a stand-in mock, an SDK, a performance test suite,
   or another format, so the contract is written once and reused everywhere.
   Reuse the existing contract and update it where behavior changes. Flag
   design choices that make callers harder to implement or future changes
   harder to adopt. See **api-documentation**.
3. Know how the real world behaves, not how it should. Knowing how an API is
   meant to work says little about how a given deployment or provider behaves.
   **api-discovery** finds an API, its owner, and the impact of a change: Orbit
   gives current endpoint, auth, required-field, and limit details for public
   APIs even when the provider is chosen, and the Context Graph shows consumers
   and dependencies beyond this repository. Another service's resources come in
   as dependencies without replacing this repository's own workspace.
4. Experiment before touching the real world. Real calls mutate data, cost
   money, and notify users, and faster reasoning doesn't make that cheaper.
   **api-simulation** runs the code against mocks of the services it calls, so
   you can test the assumptions it depends on and its failure paths, then
   change the code, then confirm against the real service. Looking something
   up or comparing code with a contract runs nothing and needs none. When other
   teams build against your API, a mock of it in your service's workspace is
   where their simulations look first; see **api-mocking**.
5. Verify the behavior at risk and keep the evidence. A saved collection reuses
   auth, variables, payloads, and assertions; a one-off check can be smaller.
   A result holds for the build, contract, environment, and permissions it ran
   against, and stops holding when one of them changes. Run results are memory
   to cite and re-read instead of re-deriving. See **api-testing**.
6. Act within the authority you were given. Secret variables let requests
   resolve credentials without the agent or a committed file ever holding the
   value; see **variables**. Changes to shared context, such as a mirroring
   share that can delete others' work, need the user's approval.
7. For webhooks, **webhook-testing** captures what the sender actually
   delivers, forwards events to a local handler, and replays captured requests
   after a fix. Its capture URL also works as a subscriber for events your API
   sends.
8. Save the finished, checked work as context. Sharing it makes the work and
   its evidence available to other sessions and teammates; a message saying
   why it changed is what the next reader needs.

Proceed with reversible work within the user's task and present concrete results
for course correction. Recommend additional work only when it closes a material
gap, such as an untested behavior or a consumer affected by an interface change.
Decline unnecessary setup or scope and explain why it would not help the task.

Important: If a CLI command says an operation isn't allowed because credits
or usage are exhausted, or the current plan does not permit it, stop retrying
and don't look for a workaround: the user needs to sign up or upgrade their
plan to continue.

## Verification

Report the outcome against the agreed conditions: what changed, which checks
ran, and the version, contract, and environment they ran against. Separate
local, simulated, and live evidence. State what was not checked, including any
consumer or upstream interaction, and which later change would invalidate the
result.

## Reporting CLI and skill gaps

When actual use exposes a CLI failure or misleading skill guidance, finish the
user's task, then report it with `postman feedback`. Include a sanitized
reproduction with the expected and observed behavior; leave out secrets, user
data, and proprietary content.
