---
name: cli-install
description: Use when the Postman CLI is missing, outdated, installed twice, or can't be installed, when `postman` is "command not found", or when a command or flag the skills expect doesn't exist in the installed version. Installs or updates the CLI through the route that put it there and finds the flags the installed version actually supports. Use for requests such as "install the Postman CLI" or "update postman".
---

# Install the Postman CLI

If `postman` is missing, install it with `npm install -g postman-cli` or a
[platform installer](reference/cli_installation.md). Update it through the
route that installed it; a second copy can shadow the first. If installing is
blocked, use **postman-mcp-server** for hosted operations.

Use `postman <resource> <action> -h` for the installed version's flags; cached
examples can describe another version. When a skill's command or flag is
missing, compare the installed version with the latest before updating.

## Verification

Report the installed version and the route it came from, and confirm `postman`
on `PATH` resolves to that copy.
