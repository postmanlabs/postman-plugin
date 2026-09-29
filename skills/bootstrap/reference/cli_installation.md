# Postman CLI Installation

Read this only when `postman` is not on `PATH`. All three installers are
official, fetch the latest release, and install globally. None is preferred;
take the first row that fits the machine.

## Pick an installer

| Machine | Installer |
| --- | --- |
| Alpine Linux — a musl-based distro common in Docker images; `/etc/alpine-release` exists | none — unsupported by every installer |
| Windows (native PowerShell or cmd) | PowerShell script |
| macOS, Linux or WSL, and the probe prints `curl: ok` | curl script |
| The probe prints `npm: ok` | npm |

On macOS, Linux and WSL, run this probe before picking a row. It checks whether
each installer can write where it installs without asking for a password:

```bash
if ! command -v curl >/dev/null; then echo "curl: absent"
elif [ -w /usr/local/bin ] || { [ ! -e /usr/local/bin ] && [ -w /usr/local ]; } || sudo -n true 2>/dev/null; then echo "curl: ok"
else echo "curl: needs password"; fi

if ! command -v npm >/dev/null; then echo "npm: absent"
else p="$(npm prefix -g)"; ok=yes
  for d in "$p/lib/node_modules" "$p/bin"; do [ -d "$d" ] || d="$p"; [ -w "$d" ] || ok=no; done
  [ "$ok" = yes ] && echo "npm: ok" || echo "npm: needs sudo"; fi
```

Never make a row fit by force: no `sudo npm install -g`, no `chown` or
`chmod` on `/usr/local` or the npm prefix. Those change the user's system.
Report what the probe printed instead.

## Install

**Windows — PowerShell script** (installs into
`%USERPROFILE%\AppData\Local\Microsoft\WindowsApps`):

```powershell
powershell.exe -NoProfile -InputFormat None -ExecutionPolicy AllSigned -Command "[System.Net.ServicePointManager]::SecurityProtocol = 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://dl-cli.pstmn.io/install/win64.ps1'))"
```

**macOS, Linux (x64 or arm64), WSL — curl script** (installs into
`/usr/local/bin`):

```bash
curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
```

The script falls back to `sudo` when `/usr/local/bin` isn't writable, and a
password prompt can't be answered from an agent shell. That is why the probe
comes first.

**Any OS with Node.js — npm:**

```bash
npm install -g postman-cli
```

## Verify

Re-run the presence check from the bootstrap skill:

```bash
command -v postman && postman --version
```

```powershell
where.exe postman; postman --version
```

An install that succeeded but isn't found means its directory is off `PATH` —
for npm, `$(npm prefix -g)/bin`. Call the binary by full path for this session
and tell the user which directory to add; don't edit their shell profile.

## If nothing fits or every attempt fails

Name what blocked you — Alpine, what the probe printed, no shell, or a hosted
session that cannot install. When the probe prints `curl: needs password` and
npm isn't `ok`, give the user the curl command to run in their own terminal,
where they can answer the password prompt, and wait. Otherwise hand off to the
`postman-mcp-server` skill; an attempted install that actually failed is the
only thing that qualifies.

Source: https://learning.postman.com/docs/postman-cli/postman-cli-installation/
