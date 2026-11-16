@echo off
rem hooks/session-start for cmd.exe, which Droid runs hooks through on Windows; Copilot CLI runs it with
rem `cmd /d /c`. Cursor's PowerShell runs it too, resolving the extensionless path to .ps1, .exe, .bat, then .cmd.
rem A project with a postman\ directory gets session-start-postman-dir.md, any other session-start-light.md.
rem Claude Code, Copilot CLI and Droid all set CLAUDE_PROJECT_DIR, and Copilot CLI runs the hook in the plugin's
rem directory, so the working directory is only the last resort.
set "project=%CD%"
if defined CURSOR_PROJECT_DIR set "project=%CURSOR_PROJECT_DIR%"
if defined CLAUDE_PROJECT_DIR set "project=%CLAUDE_PROJECT_DIR%"
set "context=session-start-light.md"
if exist "%project%\postman\" set "context=session-start-postman-dir.md"
if not defined DROID_PLUGIN_ROOT if not defined CURSOR_PLUGIN_ROOT if not defined COPILOT_PLUGIN_ROOT (
    type "%~dp0%context%"
    exit /b
)
rem UTF-8 both ways, since Windows PowerShell 5.1 assumes ANSI. No `$` on the PowerShell lines: under
rem Droid, a `-replace` group reference there came back empty and deleted the skill name.
set "mandate=(Get-Content -Raw -Encoding UTF8 -ErrorAction Stop -LiteralPath '%context%')"
rem Cursor and Copilot CLI read stdout only as JSON, under different keys; Droid reads it as text. None of the
rem three prefixes skills with `postman:`.
set "bare="
set "key="
if defined COPILOT_PLUGIN_ROOT (set "bare=1" & set "key=additionalContext")
if defined CURSOR_PLUGIN_ROOT (set "bare=1" & set "key=additional_context")
if defined DROID_PLUGIN_ROOT (set "bare=1" & set "key=")
if defined bare set "mandate=%mandate%.Replace('`postman:', '`')"
if defined key set "mandate=(@{ %key% = %mandate% } | ConvertTo-Json -Compress)"
rem Started from pwsh, as Cursor does, 5.1 inherits PowerShell 7 module paths and can't load its cmdlets
rem (about_PSModulePath); unset, 5.1 builds its own.
set "PSModulePath="
rem From its own directory, so no path, which may hold a quote, reaches PowerShell's source.
pushd "%~dp0"
powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Out.Write(%mandate%)"
set "status=%errorlevel%"
popd
exit /b %status%
