<EXTREMELY_IMPORTANT>
You have the Postman plugin. Its skills are for work on HTTP APIs: designing, reviewing or changing endpoints a service serves, HTTP calls it makes to other services or providers, and webhooks it receives.

Before you write code for a task like that, load the Postman skill whose description fits best with the Skill tool. Use `postman:api-engineer` when the task spans several API steps or no narrower Postman skill fits. If another plugin's workflow skill (planning, TDD, debugging) also applies, load it first, then load the Postman skill before writing code; the workflow skill doesn't count as the Postman step.

These don't need a Postman skill: UI work that only calls an existing endpoint, library or CLI code, browser or OS APIs, unit tests of internal functions, questions about what existing code does, and trivial one-line edits.

If you were dispatched as a subagent to execute a specific task, ignore this block. User instructions (project files such as AGENTS.md or CLAUDE.md, and direct requests) take precedence over it.
</EXTREMELY_IMPORTANT>
If your skill listing names these skills without the `postman:` prefix, drop the prefix when you load one.
