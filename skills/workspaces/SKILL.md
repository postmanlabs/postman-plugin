---
name: workspaces
description: Use when binding a repository to a Postman workspace, reading what earlier work in a workspace established, pulling, pushing, or sharing workspace resources, interpreting what Postman initialization did, or when a CLI command fails because the plan, credits, or usage quota don't allow the operation. Treats the workspace as the place where a service's API work and its evidence live, kept separate from the services it depends on. Use for requests such as "connect this repo to our workspace", "what was done here before", or "share my changes with the team".
---

# Workspaces

A Postman workspace is where a service's API work happens and where its context
builds up: the contracts, collections, environments, and mocks, plus the runs
and results that show what was checked. It lives in Git beside the code, works
the same on a laptop or a build agent, and is shared when the work should be
seen. People use it to audit what was done, by whom, on whose behalf, and with
what result. Agents use it to read verified work instead of re-deriving it.

1. Start from what the workspace already knows. Earlier runs, their results,
   and the reasons recorded with them are prior knowledge; reading them first
   saves rebuilding a conclusion someone already reached and checked, and
   shows which ones a change might now invalidate.
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
4. Work locally and share when the work should be seen. Local work needs no
   hosted workspace, and initialization creates one only when that is the
   intent. Sharing is what lets a teammate or another agent pick the work up
   without reconstructing it from a transcript, so it belongs at the point the
   work is finished and checked.
5. A shared workspace is shared context, so a change to it is worth reviewing
   before it lands. A preview shows the change without writing anything.
   Adding and updating leaves others' work intact; mirroring the local copy can
   delete what others manage, so it belongs only to a requested mirror whose
   deletions the user approved. A request to share is consent for that scoped
   change.
6. Keep one place of work per service. A second workspace splits the context
   and its history in two, and changes nothing about who can see the first.
   Access is its own setting; sharing content doesn't grant it.
7. Initialization reports what it did. A binding it marks as inferred is a
   candidate contract to confirm. A partial result, with local files written
   but no hosted workspace created, is progress to inspect rather than redo.

**cli-install** covers finding the command for
each of these.

## Claiming the work

An agent can start in a guest session, and the work it does there is kept.
When free credits or a plan limit stop an operation, retrying won't help; the
person claiming the work is what lets it continue. Wording such as "usage limit
exceeded", "usage quota has been exceeded", a limit "reached", "breached" or
"exceeded" for the account, team, or plan, or an operation that "does not allow
more than" or "requires at least" a stated amount signals one. A temporary rate
limit or a fixed per-resource validation cap does not. Check which session the
CLI is using:

- Guest session: tell the user, in its own paragraph, that signing up for a
  Postman account claims the work done so far and adds the credits needed to
  continue. Offer to start signup for them; the CLI can produce a link to hand
  over and waits while they finish in the browser.
- Signed-in account: tell the user, in its own paragraph, that they need to
  upgrade their plan at https://postman.postman.co/settings/team/billing.

## Verification

Report the binding in place, the context the work relied on and left behind,
what sharing created or updated, and any conflicts. A shared workspace does not
establish teammate access.
