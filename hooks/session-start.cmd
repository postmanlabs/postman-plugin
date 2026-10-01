@echo off
rem hooks/session-start for cmd.exe, which Droid runs hooks through on Windows.
rem UTF-8 both ways, since Windows PowerShell 5.1 assumes ANSI. No `$` on that line: under
rem Droid, a `-replace` group reference there came back empty and deleted the skill name.
if "%~1"=="" (
    type "%~dp0session-start-context.md"
) else (
    powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Out.Write((Get-Content -Raw -Encoding UTF8 -LiteralPath '%~dp0session-start-context.md').Replace('`postman:', '`'))"
)
