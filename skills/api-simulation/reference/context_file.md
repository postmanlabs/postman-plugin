# `<name>.context.yaml`

The handoff record beside a simulation: `postman/simulations/checkout.sim.yaml`
gets `checkout.context.yaml`, and a foldered simulation keeps both in its folder.
`simulation create` and the Postman app write it from a fixed template,
`simulation update` renames it with the simulation, and `simulation delete`
removes it.

**Never recreate it and never overwrite it.** It holds what earlier sessions
established, and a fresh copy throws that away while looking complete.

It carries what is believed about the services this simulation stands in for,
and what each belief rests on. **api-simulation** is how a simulation is run,
read and judged — its commands running clean is not yet the work being done.

## Its shape

The whole file is YAML under a fixed key schema. The key names and the `status`
vocabulary are fixed; the template carries each key's field schema in the
comments above it. A `null` is something nobody has established yet.

| Key | Holds |
| --- | --- |
| `purpose` | `stands_in_for` and `unblocks` — what the simulation stands in for and what work it unblocks. Both need hindsight, so they are the last thing to write. The members it serves, their route keys and the hosts they answer for are in the `.sim.yaml` beside it. |
| `assumptions` | What the code relies on about a dependency's behaviour. One claim per entry: `id`, `status`, `claim`, `reason`, `verification`, `source`, `updated_at`. |
| `fingerprints` | What the claims were written against — `id`, `date`, `commit`, `cli`. |

Everything else about this simulation lives where it already is: the members and
their origins in the `.sim.yaml`, the handlers in `postman/mocks/`, and how to
run any of it in **api-simulation**. This record is for what none of those say.

Every entry passes one test: the repo doesn't already state it. For routes,
request shapes, auth or config, name the file that holds it and let the reader
go there — one source stays true, a copy here drifts, and this file is
committed, so a named file is also how a credential stays out of it.

## What an assumption is

A claim about how a dependency behaves, which the code under test relies on:
what the caller is taken to be, which plan or permission is assumed, the order
calls go in, what gets retried, the shape of the data. A mock answers these
whether or not anyone checked, so its answer is a belief your code now carries.

```yaml
- id: summary-checks-access-before-plan
  status: supported
  claim: The summary validates the model, then asks ACS, then asks billing. A
    caller ACS refuses never reaches billing.
  reason: The policy chain fixes the order, and a run agreed with it.
  verification: Read the chain in config/policies.js, then drove one allowed
    request and one ACS refusal. The allowed request produced a billing call;
    the refused one produced none.
  source: config/policies.js:125-126; runs/summary-gates-001
  updated_at: "2026-10-28"
```

One claim per entry. A sentence holding two claims is two entries, because
evidence can settle one and leave the other standing.

### `status`

| Value | Means | For example |
| --- | --- | --- |
| `supported` | Evidence supports the claim, within a stated scope. | The provider guarantees idempotency for 24 hours. |
| `contradicted` | Evidence provides a counterexample. | A timed-out request did create an order. |
| `unknown` | Available evidence cannot establish or reject it. | Key scope across token refresh is unspecified. |
| `conflicting` | Applicable sources disagree. | Documentation promises immediate revocation; a real probe observes continued access. |

`supported` is the one to be careful with: support comes with a scope, so the
claim says what that scope is. "Idempotent for 24 hours" is supportable;
"idempotent" is not, and a claim stated that broadly is `supported` only for
the window someone actually checked.

`contradicted` and `conflicting` are findings to report, not states to route
around. A contradiction says the code relies on something untrue; a conflict
says two sources disagree and nobody has settled which governs — often a
contract promising one thing while the running service does another.

### `reason`, `verification` and `source`

Three different jobs, and keeping them apart is what makes a claim checkable.

`reason` is the judgment: why the evidence adds up to this status. It is the
field that earns its place on a `conflicting` or `unknown` claim, where the
status alone does not say what is unresolved.

`verification` is what was actually done and what it showed — a contract read,
a request made and its response, a handler inspected. Name what is still
planned or blocked and what would settle it, and say when a piece of evidence
has gone stale and why, since stale evidence stays as history but cannot
establish a current status.

`source` is where to go and re-check it, so the next session can audit the
claim rather than take it on trust. Any of:

- a file and line range in this repo, where the code shows what it relies on;
- a request that was actually made and what came back — the sequence and the
  status codes, not a summary;
- the dependency's own code, or its published contract, read for the endpoint
  in question.

A claim is only as good as what it points at, so `source` carries the specific
thing, not its category: `api/policies/hasAccess.js:12-115` rather than "read
the code". A claim with nothing to point at is `unknown`.

Where two sources disagree, `verification` says what each one showed and
`status` is `conflicting` — that is the state a contract promising one thing
while the running service does another belongs in.

### `updated_at`

The day the entry was last written, `YYYY-MM-DD`. Set it when you add a claim,
and set it again whenever you change one — a new status, a fresh piece of
verification, a reworded claim.

It is what tells a reader how old a belief is. `fingerprints` says which commit
and CLI the claims were written against; `updated_at` says when this particular
one was last looked at, which is the question you ask before depending on it. A
claim nobody has touched in months is worth re-checking whatever its status
says.

Nothing enforces this. `simulation create` writes an empty list and no command
edits entries, so the field is only as true as the session that last wrote it.

## Where claims come from

Evidence first, claim second. Make the run or read the code, then write down
what it establishes — including the parts nobody had written down before, which
are the valuable half: a call order you did not expect, a dependency answering
something the code does not handle, a member never called at all.

Going the other way — writing the claim and then looking for something to back
it — is how a guess ends up marked `supported`. A claim written ahead of any
evidence is fine; it is `unknown` until something points at it.

## Fingerprints

What the claims were written against: `git rev-parse HEAD` and
`postman --version`. Append an entry when either differs, and say so when the
tree is dirty — a sha alone reads as a clean checkout.

This is what keeps a `supported` claim from reading as current forever. A claim
carried over from an older fingerprint is one nothing has re-checked since,
which is worth knowing before a run depends on it.

## Reading it before you start

Read it before anything else, and treat what it answers as answered. The code
you are about to change still needs reading; what the dependencies around it
are taken to do is what this file is for. A session that reads the record and
then repeats the work it was meant to replace has paid for it twice.

Then read the statuses before concluding anything holds. A `supported` claim
holds until your evidence contradicts it. An `unknown` or `conflicting` one is
a question — settle it cheaply when your work depends on it, and write back
what you found.

Leave another session's claims standing unless your evidence contradicts one:
not exercised is not the same as not true.
