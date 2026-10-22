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

Keep it to the four generated sections, in Markdown, under about a screenful,
so the line that matters is the one a reader lands on rather than one they
have to search for.

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

## What earns a line

Write what running it taught you, and only that. Each line passes one test:
the repo doesn't already state it. That leaves four kinds of thing, and they
are the file's whole value:

- **A precondition you had to discover** — the setting, the service, the
  cleanup a run needs before it works at all.
- **A failure and its cause**, with where it surfaced, so the next session
  recognizes it instead of debugging it again.
- **What the simulation can't reproduce**, so a passing run is read for what
  it actually proves.
- **What the last run served**: which members took traffic, which stayed
  silent, and why.

For anything the repo does state — routes and request shapes, valid actions,
auth mechanics, each mock's hosts, config flags — point at the file that holds
it (`actions are in config/actions.js`, `credentials come from
config/env/development.js`) and let the reader go there. One source stays
true; a copy here drifts, and this file gets committed, so a named file is
also how a credential stays out of it.

Write statements that stay true between runs. Counts, timings and coverage
belong to the run that produced them, so leave them in the log and keep the
pattern here: "every member served except `workspace`" rather than a tally.

A good `## Observations` is a few lines:

```markdown
<!-- begin:observations -->
2026-10-22: every member served except `workspace`, which the service never
calls in development, and `god`, which models no endpoints. A stale Redis
`EVENT_BATCH` key from an earlier run crashed the aggregation flush before it
was cleared.
<!-- end:observations -->
```

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

- Write what you observed, and mark anything you reasoned out as reasoning,
  briefly, so the next session knows which is which.
- Leave another session's assumptions and limits standing unless your run
  contradicted one: not exercised is not the same as not true.
- Keep this file for how the simulation behaves, and let the `.sim.yaml`
  speak for what it is.
- Rewrite `## Purpose` when the simulation's scope genuinely changed.
- Prefer deleting a line to adding one. Everything here is something the next
  session must either trust or re-check.
