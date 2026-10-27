# `<name>.context.md`

The handoff record beside a simulation: `postman/simulations/checkout.sim.yaml`
gets `checkout.context.md`, and a foldered simulation keeps both in its folder.
`simulation create` and the Postman app write it from a fixed template,
`simulation update` renames it with the simulation, and `simulation delete`
removes it.

**Never recreate it and never overwrite it.** It holds what earlier sessions
established, and a fresh copy throws that away while looking complete.

## Its shape

Everything between a `<!-- begin:<name> -->` / `<!-- end:<name> -->` pair is a
YAML list that the next session parses. Keep the markers, keep the field names,
and take each `type` from the list the template carries.

`## Purpose` and `## Execution` are the only prose, and the only text you may
edit outside the markers. Everything else is appended to or has its `status`
changed.

| Section | Holds |
| --- | --- |
| `## Purpose` | What the simulation stands in for and what work it unblocks. Needs hindsight, so it is the last thing to rewrite. |
| `## Execution` | Only commands you ran successfully in this session, in order: start the simulation, start the service pointed at it, prove it is up, count what got called, stop. |
| `<!-- begin:fingerprints -->` | One entry per distinct state of the repo and tooling. What every piece of evidence is pinned to. |
| `<!-- begin:prerequisites -->` | What must be true outside the simulation — databases, caches, ports, credentials, local services — each with a `check` command. |
| `<!-- begin:assumptions -->` | One claim each, `kind: behaviour` or `kind: tooling`, with `status`, `source`, `depends_on` and `affects`. |
| `<!-- begin:observations -->` | What a run actually showed. Append only. |
| `<!-- begin:didnt-work -->` | A failure, why it misled, its cause and its fix. Append only. |

Every entry passes one test: the repo doesn't already state it. For routes,
request shapes, auth or config, name the file that holds it and let the reader
go there — one source stays true, a copy here drifts, and this file is
committed, so a named file is also how a credential stays out of it.

## 1. Before writing

- Parse every marker block first.
- Take a fingerprint: `git rev-parse HEAD`, `postman --version`, the sha256 of
  the `.sim.yaml`, of each `postman/mocks/<member>/` folder, and of the
  fixtures. If any value differs from the newest entry in fingerprints, append
  a new entry.
- Staleness pass: for each assumption, compare its `depends_on` keys between
  the fingerprint of its newest evidence and the newest fingerprint. Where any
  differ, set `status: stale`. **Never delete it.** Re-test it in this run if
  you can.

## 2. Sort what you learned

- **Prerequisites** — anything outside the simulation that must be true before
  a run works at all. Include the `check` command that shows whether it is.
- **Assumptions, `kind: behaviour`** — what the service's code relies on about
  a dependency: who the caller is, its plan, its permissions, call order,
  retries, the shape of the data. A mock answers these whether or not anyone
  checked, so its answer is a belief your code now carries.
- **Assumptions, `kind: tooling`** — what you believe about the simulation or
  the CLI. Always put `cli` in its `depends_on`.

One claim per assumption. A sentence holding two claims is two entries, because
a run can contradict one of them and leave the other standing.

## 3. Status rules

- No linked observation → `status: unknown`.
- `source: reasoned` can never be `status: confirmed`. Reading the code is not
  running it.
- `status: contradicted` requires a `counterexample`: the request sequence and
  the outcome.
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

## 5. What didn't work

Append only, one entry per failure:

- `symptom` — exactly what appeared, and where. The error text, the status, the
  member that sent it. Quote the error itself, never a response body.
- `misleading_because` — why it looked like something else. This is the field
  that saves the next session the hour you lost.
- `cause`
- `fix`

Where the fix changed a command, update `## Execution` to match.

For evidence beyond the entry, name a committed file: the handler that threw,
the mock example captured from the real service, the test that reproduces it.
Not the run's log, which lives wherever that run redirected output and which
the next run overwrites.

## 6. Before finishing

- `## Execution` contains only commands you ran successfully in this session.
  Re-run any you changed.
- Never write "works" or "proven". Write "held in the scenarios run".
- Remove nothing except stale text in `## Purpose` or `## Execution`.

## Reading it before you start

Read it before anything else, and treat what it answers as answered.
`## Execution` holds commands that ran and `## Prerequisites` holds what
someone already established, so both are usable as they stand rather than as a
starting point to rebuild from. The code you are about to change still needs
reading; the setup around it is what this file is for. A session that reads the
record and then repeats the search it was meant to replace has paid for it
twice.

Then read the statuses before concluding anything works. A `confirmed`
assumption holds until your run contradicts it. A `reasoned` or `unknown` one
is a hypothesis — check it, cheaply, when your run depends on it. A `stale` one
was true against an older fingerprint and nothing has re-tested it since. A
claim this run contradicts is a finding to report, not to quietly route around.

Leave another session's assumptions and limits standing unless your run
contradicted one: not exercised is not the same as not true.
