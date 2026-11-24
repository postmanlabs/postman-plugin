---
name: workspaces
description: Use when initializing Postman in a repository, binding it to a Postman workspace, interpreting what `postman init` did, or handling CLI-suggested actions for authentication, plan, credits, usage quota, or subscription restrictions. Treats the workspace as the place where a service's API work and its evidence live, kept separate from the services it depends on. Use for requests such as "set up Postman in this repo" or "connect this repo to our workspace".
---

# Workspaces

A Postman workspace is where a service's API work happens and where its context
builds up: the contracts, collections, environments, and mocks, plus the runs
and results that show what was checked. It lives in Git beside the code, works
the same on a laptop or a build agent, and is shared when the work should be
seen. People use it to audit what was done, by whom, on whose behalf, and with
what result. Agents use it to read verified work instead of re-deriving it.

1. `postman init` is the starting point. It gives the repository its place of
   work: Postman files beside the code and, when that is the intent, a
   workspace bound to them. `postman status` shows whether that is already
   done, so init runs only when it adds something. Init is safe to repeat and
   reports what it did: a binding it marks as inferred is a candidate contract
   to confirm, and a partial result, with local files written but no workspace
   created, is progress to inspect rather than redo.
2. One workspace holds the context of one service: one Git repository, or in a
   monorepo one remote URL and the subpath of one service.
   `.postman/resources.yaml` records that owner, so every skill, CI job, and
   teammate resolves the same context. A confirmed binding is worth reusing;
   replacing it sends the work, and its evidence, to the wrong service.
3. Other services keep their own workspaces. Their collections, environments,
   and mocks come in as dependencies through **api-discovery**, so this
   workspace reuses what another team maintains without taking it over. The
   context graph links the two, which is how a change on one side reaches work
   on the other.

## What init unlocks

A project with no `postman/` directory has nowhere to keep API work, so each
session rebuilds it. `postman init --json`, run from the repository root, sets
that up without prompting. It is worth running when the task gains from one of
these:

- **Work that can be rerun.** Init creates `postman/specs/`,
  `postman/collections/` and `postman/environments/`, and registers what goes
  in them in `.postman/resources.yaml`. A request saved there keeps its auth,
  variables and assertions, so the next session runs it instead of rebuilding
  it.
- **A session without sign-in.** When the CLI is signed out, init starts a
  temporary session and binds its personal workspace. Commands that need a
  session can then run before the user signs up. Search, the Context Graph
  and pulling other teams' dependencies still need sign-in: their answers
  come from the team's workspaces, which a temporary session can't see.
- **A workspace for results.** Commands that create monitors, publish test
  results or push artifacts default to the workspace bound in
  `.postman/resources.yaml`. When the CLI is signed in, `--json` alone writes
  only the local files; add `--visibility personal` to create and bind a
  workspace too.
- **Context for the next session.** Once init or `postman login` ties the work
  to a workspace, its runs, results and push messages are recorded there.
  The next agent session or teammate reads that record instead of working it
  out again.

Init writes only Postman files and agent instructions in `AGENTS.md`, and is
safe to rerun, so don't ask the user before you run it.

Read `exitCode` and `refusal` from the JSON payload:

- `2`: more than one spec could be authoritative. Rerun with `--spec <path>`
  for the spec the task is about.
- `4`: `postman/` already holds the project's own source files. Don't move or
  rename them. Report the refusal and do the parts of the task that don't need
  Postman files.
- `5`: the local files are written; only the workspace was not created. Don't
  rerun init.

If init started a temporary session, tell the user as "Claiming the work"
describes.

## Claiming the work

An agent can start in a temporary session without signing in. Work done there and
its context may be lost or become inaccessible when the temporary session expires unless the user
claims it with `postman signup`. When the CLI prints its temporary-session
reminder, explain this to the user and offer to start signup.

When free credits or a plan limit stop an operation, retrying won't help; the
person claiming the work is what lets it continue. Wording such as "usage limit
exceeded", "usage quota has been exceeded", a limit "reached", "breached" or
"exceeded" for the account, team, or plan, or an operation that "does not allow
more than" or "requires at least" a stated amount signals one. A temporary rate
limit or a fixed per-resource validation cap does not.

Do not retry the operations that were stopped for these reasons,
The Postman CLI will also suggest a next step in most of these cases.
Which the agent can pick up and suggest to the user and offer to start
that process for them.

If the CLI does not suggest a next step. Check which session the
CLI is using:

- Temporary/Guest session: tell the user, in its own paragraph, that signing up for a
  Postman account claims the work done so far and its context, and adds the
  credits needed to continue. Offer to start signup for them; the CLI can produce
  a link to hand over and waits while they finish in the browser.
- Signed-in account: tell the user, in its own paragraph, that they need to
  upgrade their plan at https://postman.postman.co/settings/team/billing.

## Verification

Report the binding in place and what `postman init` did.
