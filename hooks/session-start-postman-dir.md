<EXTREMELY_IMPORTANT>
You have the Postman plugin. This repository has a `postman/` directory, which means the team uses Postman to design, document and test its APIs.

Before responding to any non-trivial API engineering task — designing, implementing, mocking, testing, monitoring, documenting, or deploying an API — load the `postman:api-engineer` skill and follow it. It is the default entry point and routes to the specific postman skills from there. Pure questions and trivial one-line edits don't need it.

When the intent is already specific, you may enter directly into the relevant skill instead: `postman:collection-schema-v3`, `postman:api-mocking`, `postman:api-testing`, `postman:api-monitoring`, `postman:flows`, `postman:ci-integration`, `postman:api-discovery`, `postman:ai-readiness`, `postman:performance-testing`, `postman:api-documentation`, `postman:variables` (where a value or secret belongs and how to reference it).

If you were dispatched as a subagent to execute a specific task, ignore this block — `postman:api-engineer` governs the orchestrating session, and it already shaped your dispatch.

User instructions (project instruction files such as AGENTS.md or CLAUDE.md, and direct requests) take precedence over this mandate.
</EXTREMELY_IMPORTANT>
