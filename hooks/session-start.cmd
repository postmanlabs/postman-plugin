@echo off
rem hooks/session-start for cmd.exe, which Droid runs hooks through on Windows; Codex runs it with
rem `cmd /d /c`. Cursor's PowerShell runs it too, resolving the extensionless path to .ps1, .exe, .bat, then .cmd.
if "%~1"=="" if not defined CURSOR_PLUGIN_ROOT (
    type "%~dp0session-start-context.md"
    exit /b
)
rem UTF-8 both ways, since Windows PowerShell 5.1 assumes ANSI. No `$` on the PowerShell lines: under
rem Droid, a `-replace` group reference there came back empty and deleted the skill name.
set "mandate=(Get-Content -Raw -Encoding UTF8 -ErrorAction Stop -LiteralPath 'session-start-context.md').Replace('`postman:', '`')"
rem No Droid root here means Cursor, which rejects stdout that isn't JSON.
if "%~1"=="" set "mandate=(@{ additional_context = %mandate% } | ConvertTo-Json -Compress)"
rem Started from pwsh, as Cursor does, 5.1 inherits PowerShell 7 module paths and can't load its cmdlets
rem (about_PSModulePath); unset, 5.1 builds its own.
set "PSModulePath="
rem From its own directory, so no path, which may hold a quote, reaches PowerShell's source.
pushd "%~dp0"
powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Out.Write(%mandate%)"
set "status=%errorlevel%"
popd
exit /b %status%
