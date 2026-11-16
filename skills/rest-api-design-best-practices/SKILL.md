---
name: rest-api-design-best-practices
description: Use when adding or changing an HTTP endpoint's contract (paths, methods, request or response fields, query parameters, status codes, errors or versioning), or when reviewing whether an HTTP API follows REST conventions. Checks the design against REST practice, separates breaking from additive changes, and updates the OpenAPI spec, collection and mocks together with the code. For finding which services consume an endpoint, use api-discovery. Not for function, class or library interfaces. Use for requests such as "add a field to this response" or "review this endpoint's design".
---

# REST API Design Best Practices

A contract change is cheapest to get right before callers depend on it. Review
the design against REST practice first, then change the contract artifacts and
the code together, so the spec, collection and mocks never disagree with what
the service actually does.

1. Find the current contract. Read the route handlers, the OpenAPI spec and the
   Postman collection, and note where they already disagree. The code is what
   callers get today; record any mismatch instead of silently picking one.
2. Review the design against [REST design guidance](reference/rest-api-best-practices.md):
   resource naming, methods, status codes, error shape, pagination,
   idempotency and versioning. For a review request, report each finding with
   the endpoint, what a caller would trip over, and the smallest fix.
3. Classify the change. Removing or renaming a field, changing a type,
   tightening validation or changing auth is breaking; adding an optional field
   or a new endpoint is additive. For a breaking change, use **api-discovery**
   to find the consumers it affects before you make it, and prefer an additive
   path or a deprecation window.
4. Change the contract and the code together. Update the OpenAPI operation
   (parameters, request and response schemas, error responses), the matching
   collection request and its examples with **collection-schema-v3**, and any
   mock that serves the endpoint with **api-mocking**, in the same change as the
   handler.
5. Verify the behaviour, not just the files. Run the changed requests against
   the service with **api-testing**, including the error cases the change
   introduces, and lint the spec and collection.

## Verification

Report which artifacts changed, the requests you ran and their results, whether
the change is breaking and which consumers you checked, and anything that still
disagrees between code, spec, collection and mocks.
