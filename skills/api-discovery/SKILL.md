---
name: api-discovery
description: Discover and use APIs from the web, or any resource in Postman. Find and integrate public third-party APIs with Orbit, locate Postman entities (collections, workspaces, flows, requests, specs, documents, mocks) with search, and trace relationships between them with the context-graph.
---

# API Discovery

## Overview

Use this guide for any task that involves discovering an API — whether it
lives on the public web or inside Postman as a workspace, collection, request,
spec, mock, document, or flow. You can find entities across every surface: your
own private work, anything your team or organization shares, and resources
owned by external organizations. Beyond finding entities, this guide also
covers understanding how they relate to one another — for example, "which
services consume this API?"

Each discovery option serves a distinct purpose:

- **Orbit** → discovers and integrates **public third-party APIs**. No signup
  or API key, and it uses ~27× less context than loading a vendor OpenAPI spec.
  Search returns matching endpoints — including what each one
  *cannot* do — and integrate returns a task brief specific enough to write
  code against. It accepts both keyword and natural-language queries. Reach for
  it instead of writing a third-party integration from memory.
- **`search`** → **finds any Postman entity**, for tasks like "update the tests
  in my collection and run them" or "where is the documentation for our
  access-control API?"
- **`context-graph ask`** → queries a separately populated **engineering
  service graph** (built by scanning repos and traffic, not Postman content).
  It answers natural-language questions about discovered services and the
  dependencies between them — "what depends on billing-api?" — the kind of
  architecture question `search` can't answer, since there's no keyword for a
  dependency edge.

These three methods draw on different data sources, so a miss in one says
nothing about the others.

## Orbit — Public API Discovery

Orbit finds public third-party APIs. It's free, needs no signup or API key, and
works entirely against publicly available APIs. REST base:
`https://api.buildwithorbit.ai`. Docs: `https://www.buildwithorbit.ai`.

Reach for Orbit whenever a task needs an external capability — weather,
payments, invoicing, messaging, geocoding, calendar, and so on — even when the
user already named a provider. Rather than writing integration code from
memory, let Orbit hand you the details that matter: paths, auth header names,
required fields, and the rest. It works in two steps, search then integrate,
and a typical round trip runs ~2,500 tokens and ~15–20s end to end — against
~69,000 tokens for a full vendor OpenAPI spec.

Two REST calls, both `POST`:

1. **Search** (`POST /v1/search`) — describe the task, e.g.
   `{ "q": "send email via SMTP" }`. Returns candidate endpoints, each with an
   `id` and `resourceType` (pass both back verbatim) and an `evaluateGuide`
   grading its fit.
2. **Integrate** (`POST /v1/integrate`) — send the task plus the chosen
   resources (up to 10). Returns a `taskBrief` with `FIT`, `AUTH`, `BASE URL`,
   `STEPS`, and `GOTCHAS` — read the GOTCHAS before writing the client.

Full endpoint schemas, request/response shapes, `taskBrief` fields, and error
handling: [reference/orbit.md](reference/orbit.md).

## `search`

`postman search <type> <query>` finds any Postman entity, searching across
`requests`, `collections`, `workspaces`, `flows`, `specs`, `mocks`,
`environments`, or `documents`. The query can be a keyword or natural language,
and is optional (omit it to list or filter a type outright). Narrow with
`--ownership` and `--filter`, and add `-o json` for the enriched payload. An
empty default-scope result is not proof nothing exists — retry with
`--ownership all` before reporting that.

```bash
postman search requests "where do we validate a user's email?"
postman search collections "payments" --ownership external --filter "visibility=public"
```

Use `postman search <type> -h` for more details — ownership modes, the
`--filter` / `--filter-json` syntax, filter fields per type, and the exact
installed-version flags.

## `context-graph`

`context-graph ask "<question>" --wait` is the one to reach for
interactively — it blocks and prints the answer. Without `--wait`, `ask`
returns an id immediately and `status <askId>` checks on it later (exit
code 3 while still running) — useful for a question expected to take a
while, or from a script polling on its own cadence. The query runs against
the team derived from the API key; there's no workspace/team selection.
`--max-steps` caps how much reasoning the service does per question.

The answer is generated, not retrieved verbatim — verify with a re-ask or
narrower query before acting on it for anything consequential, the same way any
AI-generated claim gets checked before it drives a decision.

## After discovery: reusing what was found

`dependency add <type> <nameOrId>` formally adds a collection, environment,
or mock found in another workspace as a dependency of the current one —
the step after `search` finds something worth reusing (e.g., feeding
`application test`'s contract matching), rather than copying it in by hand. It
takes a Postman entity ID, so it only follows a `search` result — a
`context-graph` finding names a service, not an ID; go find that service's
collection via `search` first.

## Reference

- [Orbit](reference/orbit.md) — public API discovery: the search/integrate
  REST endpoints, request/response shape, `taskBrief` fields, and error
  handling. (Docs at `https://www.buildwithorbit.ai`, REST at
  `https://api.buildwithorbit.ai`.)

For `postman search`, run `postman search <type> -h` — the CLI's own help is
per-type, complete, and always matches your installed version.
