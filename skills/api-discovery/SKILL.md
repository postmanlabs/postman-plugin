---
name: api-discovery
description: Discovers existing API endpoints, contracts, and saved Postman artifacts before a software integration. Use when the user explicitly asks to search for, find, or select a public or third-party API for a capability such as SMS or payments; asks whether an external API or Postman request, collection, or spec already exists; or asks how services relate. Covers `postman search`, `postman context-graph`, and `postman describe instructions discovery`. Do not use for market, pricing, vendor, product, or general web research unless the user also wants to select or reuse an API endpoint, contract, or saved Postman artifact.
---

# API Discovery

## Overview

Two mostly-separate datasets — pick by data source, not question shape,
but the boundary isn't absolute (see Critical Rule 1):

- **`search` / `describe`** → **Postman-authored artifacts** someone saved
  in Postman (collections, requests, specs, mocks, workspaces). Matches
  text; doesn't reason. "Does something named/shaped like X exist?"
- **`context-graph ask`** → an **engineering service graph** —
  natural-language Q&A over discovered services and the dependency edges
  between them. "What depends on billing-api?" — architecture questions
  `search` structurally can't answer, since there's no keyword for a
  dependency edge. Its own docs describe the graph as built from
  repo/traffic scanning rather than Postman content, but that's an
  unverified claim about construction, not a settled fact — a live query
  about a real Postman API returned genuine, independently-confirmed
  Postman Workspace data.

A miss in one is not proof of a miss in the other (check each against its
own source first) — but don't hard-refuse a Postman-content question to
the Context Graph on principle, and don't fall back to it just because a
`search` came back empty, or vice versa.

## `search`

`search <type> <query>` where type is `requests`, `collections`,
`workspaces`, `flows`, `specs`, `mocks`, `environments`, or `documents`.
Default `--ownership organization` only searches inside your org — pass
`external` or `all` before concluding "no API for this exists," since a
partner or public API published outside the org is invisible at the
default scope. `--filter "method=POST AND workspaceId=ws-123"` narrows
further; see [reference/search_filters.md](reference/search_filters.md) for
the full filter field and operator syntax per element type.

### Finding a public or third-party API by capability

When the user needs an API for a capability rather than an artifact they
already know by name, run `postman describe instructions discovery` before
assembling the search sequence. Search the external dataset (or `all` when
both internal reuse and public options are relevant) for requests,
collections, and specs that provide the capability.

A public Postman artifact proves discoverability, not suitability or
authority. Inspect the concrete request or contract, identify its publisher,
and verify the current provider documentation before choosing it. Apply the
user's actual constraints, such as authentication, region, sandbox support,
or required features; don't choose by search rank alone.

Once there is a candidate request or URL, use **api-testing** to verify it.
Prefer a saved collection request when one exists; otherwise use `postman
request` with the bare URL. A bare URL or local collection does not require
**bootstrap**. For APIs with real-world side effects such as SMS or payments,
use a documented sandbox, test recipient, or non-mutating validation endpoint
instead of sending a real message or charge merely to prove connectivity.
After verification, return to the requested implementation and run its local
checks.

## `context-graph`

`context-graph ask "<question>" --wait` is the one to reach for
interactively — it blocks and prints the answer. Without `--wait`, `ask`
returns an id immediately and `status <askId>` checks on it later (exit
code 3 while still running) — useful for a question expected to take a
while, or from a script polling on its own cadence. The query runs against
the team derived from the API key; there's no workspace/team selection.
`--max-steps` caps how much reasoning the service does per question.

The answer is generated, not retrieved verbatim — verify with a re-ask or
narrower query before acting on it for anything consequential (Critical
Rule 3), the same way any AI-generated claim gets checked before it drives
a decision.

## `describe instructions discovery`

Postman ships its own prescribed discovery workflow for AI coding agents —
`postman describe instructions discovery` prints it. Read this before
building a custom discovery flow out of `search`/`describe` primitives;
it's Postman's own recommended sequence (search/describe only, no
`context-graph`), not a blank slate to reinvent.

## After discovery: reusing what was found

`dependency add <type> <nameOrId>` formally adds a collection, environment,
or mock found in another workspace as a dependency of the current one —
the step after `search`/`describe` finds something worth reusing (e.g.,
feeding `application test`'s contract matching), rather than copying it in
by hand. It takes a Postman entity ID, so it only follows a `search`/
`describe` result — a `context-graph` finding names a service, not an ID;
go find that service's collection via `search` first.

## Critical Rules

1. **`context-graph` and `search`/`describe` mostly don't share a
   dataset** (see Overview), so check an absence against its own source
   first — but the boundary isn't absolute. A `context-graph ask` about a
   real Postman API has been observed to return genuine Postman Workspace
   data, so don't hard-refuse a Postman-content question to `context-graph`
   on principle, and don't fall back to it just because a `search` came
   back empty, or vice versa, without checking each source directly.
2. **An empty default-scope `search` is not proof nothing exists.** Retry
   with `--ownership all` before reporting "no API for this" to the user.
3. **A Context Graph answer is generated reasoning, not a database read.**
   Verify it against a concrete source before treating it as fact,
   especially for anything the user will act on.
4. **`search`, `context-graph`, and `describe` are Beta or recently added
   surfaces.** Re-run `-h` before trusting a command or flag name here if
   the installed CLI is newer than this file assumes — these are the
   commands most likely to have changed since this was written.

## Verification

State which tool actually answered the question (search vs. Context Graph)
and at what `--ownership` scope or with what `--max-steps`/query — a
discovery answer is only as trustworthy as the scope it ran at. For a public
API selection, also state which candidate was chosen, how its provenance and
current documentation were checked, and the separate endpoint-test result.

## Reference

- [Search filter syntax](reference/search_filters.md) — filter fields and
  operators per element type, and `--filter-json` shape.
