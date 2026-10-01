@echo off
rem hooks/session-start for cmd.exe, which Droid runs hooks through on Windows.
if "%~1"=="" (
    type "%~dp0session-start-context.md"
    exit /b
)
rem UTF-8 both ways, since Windows PowerShell 5.1 assumes ANSI. No `$` on that line: under
rem Droid, a `-replace` group reference there came back empty and deleted the skill name.
rem From its own directory, so no path, which may hold a quote, reaches PowerShell's source.
pushd "%~dp0"
powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Out.Write((Get-Content -Raw -Encoding UTF8 -ErrorAction Stop -LiteralPath 'session-start-context.md').Replace('`postman:', '`'))"
set "status=%errorlevel%"
popd
exit /b %status%
