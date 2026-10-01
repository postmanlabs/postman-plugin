---
name: postman-mcp-server
description: Postman concepts and MCP tool guidance. Loaded when working with Postman MCP tools to make better decisions about tool selection and workarounds.
user-invocable: false
---

# Postman Knowledge

Reference for Postman concepts and MCP tool selection. Use this context when working with Postman MCP tools to make better decisions.

See `references/setup.md` for how to set up the Postman MCP server and auth.

## Core Concepts

- **Collection:** A group of API requests organized in folders. The primary unit of work in Postman. Contains requests, examples, tests, and documentation.
- **Environment:** Key-value pairs (variables) scoped to a context (dev, staging, prod). Used to swap base URLs, auth tokens, and config without changing requests.
- **Workspace:** Container for collections, environments, and specs. Can be personal, team, or public.
- **Spec (Spec Hub):** An OpenAPI or AsyncAPI definition stored in Postman. Can generate collections and stay synced.
- **Request:** A single API call definition (method, URL, headers, body, tests).
- **Response:** A saved example response for a request. Used by mock servers and documentation.
- **Folder:** A grouping within a collection, typically by resource (e.g., "Users", "Orders").
- **Tags:** Labels on collections for categorization and search.
- **Monitor:** A scheduled collection runner that checks API health.
- **Mock Server:** A fake API that serves example responses from a collection.

## Decision Guide

| Goal | Approach | Workflow |
|------|----------|----------|
| Push code changes to Postman | Create/update spec in Spec Hub, then sync to collection | `references/sync.md` |
| Consume a Postman API | Read collection + generate client code | — |
| Find an API | Use `searchPostmanElements`, then drill into details | `references/search.md` |
| Test an API | Run collection with `runCollection` | `references/test.md` |
| Create a fake API for frontend | Create mock server from collection with examples | `references/mock.md` |
| Document an API | Analyze collection completeness, fill gaps, optionally publish | `references/docs.md` |
| Audit API security | Run security checks against spec or collection | `references/security.md` |
| Learn how to use a Postman feature | Search Postman docs with `searchLearningCenter` (Full mode) | `references/learn.md` |

When the goal's row names a workflow file, read it before the first tool call.

## MCP Tool Selection

**Workspace operations:** `getWorkspaces`, `getWorkspace`, `createWorkspace`
**Collection CRUD:** `getCollections`, `getCollection`, `createCollection`, `putCollection`, `patchCollection`, `deleteCollection`
**Request/Response:** `getCollectionRequest`, `createCollectionRequest`, `updateCollectionRequest`, `getCollectionResponse`, `createCollectionResponse`, `updateCollectionResponse`
**Folder management:** `getCollectionFolder`, `createCollectionFolder`, `updateCollectionFolder`
**Spec Hub:** `getAllSpecs`, `getSpec`, `createSpec`, `getSpecDefinition`, `updateSpecFile`, `getSpecFiles`
**Sync:** `generateCollection`, `syncCollectionWithSpec`, `syncSpecWithCollection`
**Environments:** `getEnvironments`, `getEnvironment`, `createEnvironment`, `putEnvironment`
**Mocks:** `getMocks`, `getMock`, `createMock`, `publishMock`, `unpublishMock`
**Tests:** `runCollection`
**Docs:** `publishDocumentation`, `unpublishDocumentation`
**Search:** `searchPostmanElements` , `getTaggedEntities`
**Learning Center:** `searchLearningCenter` (Full mode only — searches Postman product docs for how-to guidance)
**User:** `getAuthenticatedUser`

## Known Limitations

The sync, mock and create paths all hit these; a missed one looks like success
or fails without a useful error.

- **`generateCollection` is async.** It returns HTTP 202, not the collection.
  Poll `getGeneratedCollectionSpecs` or `getSpecCollections`;
  `getAsyncSpecTaskStatus` may return 403 on some plans.
- **`syncCollectionWithSpec` is async and OpenAPI 3.0 only.** Poll
  `getCollectionUpdatesTasks`. For Swagger 2.0 or OpenAPI 3.1, `updateSpecFile`
  and then `generateCollection` instead.
- **`createCollection` can't nest folders.** Create the collection, then
  `createCollectionFolder`, then `createCollectionRequest` into each folder.
- **`putCollection`'s auth enum has no `noauth`.** Let no-auth endpoints inherit
  collection-level auth.
- **`createSpec` fails above roughly 50KB.** For large APIs, parse the spec
  locally and build the collection with `createCollection`,
  `createCollectionFolder`, `createCollectionRequest` and
  `createCollectionResponse`.

## Workflows

Each reference below is a full MCP-tool workflow for one goal — the tool
call sequence, what to present at each step, and error handling. Reach for
one once the Decision Guide above has picked a goal; they assume MCP tools
only, no `postman` CLI.

- `references/setup.md` — first-run auth (OAuth or API key) and workspace verification.
- `references/search.md` — discover APIs across workspaces with `searchPostmanElements`.
- `references/sync.md` — create/update collections from specs, or sync a spec from collection changes.
- `references/mock.md` — create a mock server from a collection or spec.
- `references/test.md` — run collection tests and diagnose failures.
- `references/docs.md` — generate, improve, and publish API documentation.
- `references/security.md` — audit a spec or collection against the OWASP API Top 10.
- `references/learn.md` — search the Postman Learning Center for how-to guidance.
