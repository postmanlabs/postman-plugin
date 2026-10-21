# `<name>.context.md`

The handoff document beside a simulation: `postman/simulations/checkout.sim.yaml`
gets `checkout.context.md`, and a foldered simulation keeps both in its folder.
`simulation create` and the Postman app write it from what they already know,
`simulation update` renames it with the simulation, and `simulation delete`
removes it. An existing one is never overwritten, because it holds what earlier
sessions learned.

It is prose for whoever works here next, human or agent. Nothing parses it, so
there is no schema to satisfy — but the generated headings and the
`<!-- begin:observations -->` markers are what a reader and the next write
expect to find, so keep them.

## What the generated file contains

A fresh file states the simulation's name, the date, its members and the hosts
they stand in for, and the run command for this simulation's own path.
Everything needing someone who has actually run it is left as an `@todo` HTML
comment, so a half-filled file reads as half-filled instead of as fact.

| Section | Holds |
| --- | --- |
| Header | Generation date and what the mocks came from. |
| `## Purpose` | What the simulation stands in for and what work it unblocks. Generated as the member list and a pointer to the handlers; needs hindsight, so it is the last thing to rewrite. |
| `## Execution` | The commands, in order: start the simulation, start the service pointed at it, prove it is up, count what got called, stop. The generated block leaves the service's own command, the proof request, the port and the log path as `@todo`. |
| `## Assumptions` | Every precondition someone had to discover, the seeded data worth reusing, and what the simulation cannot reproduce. Each is a bold claim and the consequence of it not holding. |
| `## Observations` | The last run only, between the `begin`/`end` markers: which members took traffic, which took none, and anything surprising. A summary, not a request log. |

Four assumptions come generated, so don't restate them: an unmatched request
reaches the real host, mocks don't hot-reload, only HTTP dependencies are
simulated, and the port must be free with one simulation at a time.

## Working with it

Read it before starting and treat it as true. Check the assumptions and
anything recorded about what a run doesn't prove before concluding that
something works. A claim this run contradicts is a finding to report, not to
quietly route around.

Then work from it instead of rebuilding what it already answers: run
`## Execution`'s commands as written rather than reconstructing them from the
`.sim.yaml` and the handlers, and don't re-derive a precondition
`## Assumptions` already records. Read the code you are about to change; don't
rediscover the setup around it. A session that reads the document and then
repeats the search it was meant to replace has paid for it twice.

Then leave it truer than you found it:

- Replace the `@todo`s your run can answer, and delete each one you replace.
- Correct what you found wrong. Say what it is now, not what it used to be.
- Add the precondition you had to discover, or the thing the simulation turned
  out not to reproduce, as another claim-and-consequence pair.
- Replace the `## Observations` block with this run's summary, read from the
  simulation's log.

A run that only confirms the file still rewrites `## Observations`.

## Rules

- Record what you observed, not what you assume. Keep anything you only
  reasoned out brief, and don't write it as confirmed.
- Don't delete another session's assumption because this run didn't hit it.
  Not exercised is not the same as not true.
- Don't restate the simulation definition. If it's in the `.sim.yaml`, it
  doesn't belong here.
- Don't rewrite `## Purpose` unless the simulation's scope genuinely changed.
