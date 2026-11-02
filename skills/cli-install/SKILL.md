---
name: cli-install
description: Use when the Postman CLI is missing, outdated, installed twice, or can't be installed, when `postman` is "command not found", or when a command or flag the skills expect doesn't exist in the installed version. Installs or updates the CLI through the route that put it there and finds the flags the installed version actually supports. Use for requests such as "install the Postman CLI" or "update postman".
---

# Install the Postman CLI

Install it globally so `postman` is on `PATH`. If installing is blocked, use
**postman-mcp-server** for hosted operations.

```bash
# npm, any platform with Node
npm install -g postman-cli

# macOS, Linux, and WSL
curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
```

```powershell
# Windows
powershell.exe -NoProfile -InputFormat None -ExecutionPolicy AllSigned -Command "[System.Net.ServicePointManager]::SecurityProtocol = 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://dl-cli.pstmn.io/install/win64.ps1'))"
```

## Update

Run the command that installed it. A different route leaves two `postman`
binaries and a question of which one `PATH` finds; never `npm install -g` over a
copy from the curl installer or a system package manager. The CLI has no
self-update command, and `postman skills update` refreshes a repository's
`postman/skills/`, not the binary.

Compare `postman --version` with `npm view postman-cli version` when a skill's
command or flag is missing, and use `postman <resource> <action> -h` for the
flags the installed version supports; cached examples can describe another
version.

## Uninstall

`npm uninstall -g postman-cli` for an npm install. Otherwise delete the
`postman` binary from `/usr/local/bin` on macOS, Linux, and WSL, or from
`%USERPROFILE%\AppData\Local\Microsoft\WindowsApps` on Windows.

## Verification

Report the installed version and the route it came from, and confirm `postman`
on `PATH` resolves to that copy.

Source: https://learning.postman.com/docs/postman-cli/postman-cli-installation/
