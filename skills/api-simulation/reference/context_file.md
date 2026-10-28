# `<name>.context.yaml`

The handoff record beside a simulation: `postman/simulations/checkout.sim.yaml`
gets `checkout.context.yaml`, and a foldered simulation keeps both in its folder.
`simulation create` and the Postman app write it from a fixed template,
`simulation update` renames it with the simulation, and `simulation delete`
removes it.

**Never recreate it and never overwrite it.** It holds what earlier sessions
established, and a fresh copy throws that away while looking complete.

It is what is true of this simulation. **api-simulation** is how a simulation
is run, read and judged — its commands running clean is not yet the work being
done.

## Its shape

The whole file is YAML under a fixed key schema. The key names and the `type`
vocabulary are fixed; the template carries each key's field schema, that
vocabulary and a worked example in the comments above it, and points here for
everything below. A `null` is something nobody has established yet.

`purpose` and `setup` are the only keys a session rewrites. Everything else
is appended to, or has an entry's `status` changed.

| Key | Holds |
| --- | --- |
| `purpose` | `stands_in_for` and `unblocks` — what the simulation stands in for and what work it unblocks. Both need hindsight, so they are the last thing to write. The members it serves, their route keys and the hosts they answer for are in the `.sim.yaml` beside it. |
| `setup` | The shared starting point: an ordered list of steps, each `id`, `what` and `command` — start the simulation, start the service pointed at it, confirm it answers, read what it served, stop. Only commands you ran successfully in this session; a `command: null` is a step nobody has run. |
| `fingerprints` | One entry per distinct state of the repo and tooling — `id`, `date`, `commit`, `cli`. What every piece of evidence is pinned to, and what lets a `confirmed` claim go stale. |
| `prerequisites` | What must be true outside the simulation — databases, caches, ports, credentials, local services — each with a `check` command. |
| `assumptions` | One claim each: `id`, `type`, `claim`, `consequence` and `affects` are the claim and stay put; `verification` holds the `status`, `source`, `depends_on` and `counterexample` that a run changes. |
| `observations` | What a run actually showed. Append only. |
| `didnt_work` | A failure, why it misled, its cause and its fix. Append only. |

Every entry passes one test: the repo doesn't already state it. For routes,
request shapes, auth or config, name the file that holds it and let the reader
go there — one source stays true, a copy here drifts, and this file is
committed, so a named file is also how a credential stays out of it.

### What `setup` holds

`setup` is the shared starting point: bring the simulation up, bring the service
up against it, confirm it answers, read what it served, take it down. It is the
same for everyone whatever they came to do, which is what makes it safe to run
top to bottom before reading any further.

A command that belongs to one claim — making a member fail, moving a plan,
denying a permission, seeding a row — lives with that claim, named in the
assumption's `consequence` or in the observation that recorded what it showed.
There it travels with the reason someone would run it, and a reader meets it
when they are asking about that claim.

One test for a step: a reader who knows nothing else about this service would
still want to run it.

## 1. Before writing

- Parse the whole file first.
- Take a fingerprint: `git rev-parse HEAD` and `postman --version`. If either
  differs from the newest entry in `fingerprints`, append a new entry. The
  `.sim.yaml` and the mock handlers are tracked files, so the commit sha is what
  covers them; where the tree is dirty, the entry says so, since a sha alone
  reads as a clean checkout.
- Staleness pass: for each assumption, compare its `depends_on` keys between
  the fingerprint of its newest evidence and the newest fingerprint. Where any
  differ, set `status: stale`. **Never delete it.** Re-test it in this run if
  you can.

## 2. Sort what you learned

- **`prerequisites`** — anything outside the simulation that must be true
  before a run works at all. Include the `check` command that shows whether it
  is.
- **`assumptions`, `type: behaviour.*`** — what the service's code relies on
  about a dependency: who the caller is, its plan, its permissions, call order,
  retries, the shape of the data. A mock answers these whether or not anyone
  checked, so its answer is a belief your code now carries.
- **`assumptions`, `type: tooling.*`** — what you believe about the simulation
  or the CLI. Always put `cli` in its `verification.depends_on`.

One claim per assumption. A sentence holding two claims is two entries, because
a run can contradict one of them and leave the other standing.

## 3. Status rules

Everything here lives under an assumption's `verification`, except `affects`.

- No linked observation → `status: unknown`. There is no evidence list on the
  assumption: observations point in through their `supports` and `contradicts`,
  so an absence of inbound links is what `unknown` means.
- `source: reasoned` can never be `status: confirmed`. Reading the code is not
  running it.
- `status: contradicted` requires a `counterexample`: the request sequence and
  the outcome.
- `depends_on` names the `fingerprints` keys this claim is sensitive to —
  `commit`, `cli`, or both — and is never empty, since it is what the staleness pass
  compares.
- `affects` names the file and line range that relies on the claim, so a
  contradicted assumption points at the code to revisit.
- For every `unknown` behaviour assumption, run the collection again with
  member scenarios that would test it, and record the result as an
  observation. An unknown is the question the next run exists to answer, not a
  gap to note and leave.

## 4. Observations

Append only. Never edit or delete one; a newer entry supersedes an older one,
and the pair is how a pattern becomes visible — a member silent across three
runs is worth more than the same fact seen once.

Each entry carries its `id`, `date`, `session`, the exact `run` command, the
`scenarios` used (`{}` for defaults), what it `saw` (log lines, request order,
status codes), what it `supports`, what it `contradicts`, and its
`fingerprint`.

### An observation can create an assumption

The order is: a run shows something, and the belief follows from it. So write
the observation first, from what the log and the responses actually say, and
only then ask what each part of it settles.

Most of what a run shows will answer an assumption that is already there. What
does not is the valuable half: a request order nobody had written down, a
dependency answering something the code did not expect, a member never called at
all. That is a new assumption — add it, with `source: observed`, and point the
observation's `supports` at it. An observation whose `supports` is empty is a
session that saw something and drew nothing from it.

Going the other way — inventing an assumption and then looking for a run to
confirm it — is how a guess ends up marked `confirmed`. An assumption written
before any run exists is fine, but it is `source: reasoned` and `status:
unknown` until a run says otherwise.

## 5. What didn't work

Append only, one entry per failure:

- `symptom` — exactly what appeared, and where. The error text, the status, the
  member that sent it. Quote the error itself, never a response body.
- `misleading_because` — why it looked like something else. This is the field
  that saves the next session the hour you lost.
- `cause`
- `fix`

Where the fix changed a command, update `setup` to match.

For evidence beyond the entry, name a committed file: the handler that threw,
the mock example captured from the real service, the test that reproduces it.
Not the run's log, which lives wherever that run redirected output and which
the next run overwrites.

## 6. Before finishing

- `setup` contains only commands you ran successfully in this session.
  Re-run any you changed.
- Never write "works" or "proven". Write "held in the scenarios run".
- Remove nothing except stale entries in `purpose` or `setup`.

## Reading it before you start

This record carries one simulation's particulars: its commands, its
prerequisites, what its runs showed. **api-simulation** carries the method —
which mode to run in, what the log's own answers mean, how to make a dependency
fail, and what a pass does and doesn't prove. The two together are a run you
can judge; the record alone is the happy path, with nothing to diagnose from
the moment it stops holding.

What the record answers is answered.
`setup` holds commands that ran and `prerequisites` holds what someone
already established, so both are usable as they stand rather than as a starting
point to rebuild from. The code you are about to change still needs reading;
the setup around it is what this file is for. A session that reads the record
and then repeats the search it was meant to replace has paid for it twice.

Then read the statuses before concluding anything works. A `confirmed`
assumption holds until your run contradicts it. A `reasoned` or `unknown` one
is a hypothesis — check it, cheaply, when your run depends on it. A `stale` one
was true against an older fingerprint and nothing has re-tested it since. A
claim this run contradicts is a finding to report, not to quietly route around.

Leave another session's assumptions and limits standing unless your run
contradicted one: not exercised is not the same as not true.
