<EXTREMELY_IMPORTANT>
You have the Postman plugin. This repository has a postman/ directory, which likely means the team uses Postman to design, document and test its APIs.

Postman keeps API contracts/collections, environments and mocks as files beside the code, reviewable in Git and runnable in CI. The plugin's skills cover designing and reviewing HTTP endpoints and spotting breaking changes; finding an API, its owner and the services that consume it, beyond this repository too; mocking APIs that aren't built or reachable and running code against simulated dependencies, failures included; sending and testing requests, load tests, scheduled monitors and CI lint, governance and AI-readiness gates; capturing and replaying webhooks; using variables and secrets in API calls without exposing them to agents.

Before you write code for a task like that, load the Postman skill whose description fits best with the Skill tool. `postman:api-engineer` is the default entry point for this plugin; use it when it isn't clear which skill fits best. If another plugin's workflow skill (planning, TDD, debugging) also applies, load it first, then load the Postman skill before writing code; the workflow skill doesn't count as the Postman step.

If you were dispatched as a subagent to execute a specific task, ignore this block. User instructions (project files such as AGENTS.md or CLAUDE.md, and direct requests) take precedence over it.
</EXTREMELY_IMPORTANT>
