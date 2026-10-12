# Runs install.ps1 against stub agents under the PowerShell that runs this file, and prints PASS or FAIL per
# scenario. CI runs it under Windows PowerShell 5.1 and PowerShell 7. Windows only: the stubs are .cmd files.
#
#   powershell -ExecutionPolicy Bypass -File install/test/install-ps1.test.ps1
#   pwsh -File install/test/install-ps1.test.ps1

$ErrorActionPreference = 'Continue'
$ps = (Get-Process -Id $PID).Path
$script = (Resolve-Path (Join-Path $PSScriptRoot '..\install.ps1')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ("pm plug-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$bin = Join-Path $root 'bin'
$log = Join-Path $root 'cmds.log'
$home_ = Join-Path $root "h$([char]0xE9) user"
$fails = 0
$port = 18765

$official = '[{"name":"claude-plugins-official","source":"github","repo":"anthropics/claude-plugins-official"}]'

function Check($name, $cond, $detail) {
    if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name :: $detail"; $script:fails++ }
}

# Stub agents print canned JSON for the two list commands and record every other call.
function New-Scenario($plugins, $marketplaces, $failOn, $message) {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $bin, $home_ -Force | Out-Null
    New-Item -ItemType File -Path $log -Force | Out-Null
    if (-not $message) { $message = 'boom C:\Users\someone\secret' }
    foreach ($name in 'claude', 'codex') {
        $lines = @('@echo off', "echo $name %* >> `"$log`"", "echo %* | findstr /C:`"--version`" >nul && (echo 2.1.296 Agent Name & exit /b 0)")
        if ($failOn) { $lines += "echo %* | findstr /C:`"$failOn`" >nul && (echo $message 1>&2 & exit /b 1)" }
        $lines += "echo %* | findstr /C:`"plugin list --json`" >nul && (echo $plugins & exit /b 0)"
        $lines += "echo %* | findstr /C:`"marketplace list --json`" >nul && (echo $marketplaces & exit /b 0)"
        $lines += 'exit /b 0'
        Set-Content -Path (Join-Path $bin "$name.cmd") -Value $lines -Encoding ASCII
    }
}

function Get-Commands { @(Get-Content $log | Where-Object { $_ -and $_ -notmatch '--version' }) }

# Runs the script in a child PowerShell with a PATH holding only the stubs. $mode is file or iex.
function Invoke-Install($agentArgs, $envs = '', $mode = 'file', $prefix = '', $policy = 'Bypass') {
    $path = "$bin;$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:ProgramFiles\Git\cmd"
    $setup = "`$env:PATH='$path'; `$env:USERPROFILE='$home_'; `$env:POSTMAN_PLUGIN_CURSOR_APP='$root\none'; $envs"
    $run = if ($mode -eq 'iex') { "Get-Content -Raw '$script' | iex; exit `$LASTEXITCODE" } else { "& '$script' $agentArgs; exit `$LASTEXITCODE" }
    $out = & $ps -NoProfile -ExecutionPolicy $policy -Command "$setup; $prefix $run" 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Out = $out }
}

New-Scenario '[]' '[]' ''
$r = Invoke-Install '-Agent claude-code'
$cmds = (Get-Commands) -join '|'
Check 'claude: fresh install' ($r.Code -eq 0 -and $r.Out -match 'result claude-code installed' -and $cmds -match 'marketplace add anthropics/claude-plugins-official --scope user' -and $cmds -match 'plugin install postman@claude-plugins-official --scope user') "$($r.Code) $($r.Out) $cmds"

New-Scenario '[{"id": "postman@claude-plugins-official", "scope": "user"}]' $official ''
$r = Invoke-Install '-Agent claude-code'
Check 'claude: installed plugin left alone' ($r.Code -eq 0 -and $r.Out -match 'result claude-code already-installed' -and (Get-Commands).Count -eq 1) "$($r.Code) $($r.Out)"

New-Scenario '[]' '[{"name":"claude-plugins-official","repo":"someone/fork"}]' ''
$r = Invoke-Install '-Agent claude-code'
Check 'claude: foreign marketplace blocks' ($r.Code -eq 1 -and $r.Out -match 'result claude-code failed marketplace-source-mismatch') "$($r.Code) $($r.Out)"

New-Scenario '[]' $official 'plugin install'
$r = Invoke-Install '-Agent claude-code'
Check 'claude: failed install' ($r.Code -eq 1 -and $r.Out -match 'result claude-code failed install-failed') "$($r.Code) $($r.Out)"

New-Scenario '{"installed":[]}' '{"marketplaces":[]}' ''
$r = Invoke-Install '-Agent codex'
$cmds = (Get-Commands) -join '|'
Check 'codex: fresh install' ($r.Code -eq 0 -and $r.Out -match 'result codex installed' -and $cmds -match 'marketplace add postmanlabs/postman-plugin --json' -and $cmds -match 'plugin add postman@postman --json') "$($r.Code) $($r.Out) $cmds"

New-Scenario '{"installed":[{"pluginId":"postman@postman","installed":true}]}' '{"marketplaces":[]}' ''
$r = Invoke-Install '-Agent codex'
Check 'codex: installed plugin left alone' ($r.Code -eq 0 -and $r.Out -match 'result codex already-installed') "$($r.Code) $($r.Out)"

New-Scenario '[]' '[]' ''
$r = Invoke-Install '-Agent claude-code,codex'
Check 'comma list runs both' ($r.Out -match 'result claude-code installed' -and $r.Out -match 'result codex') $r.Out

# Cursor with real git, under a profile folder that has a space and a non-ASCII letter
New-Scenario '[]' '[]' ''
New-Item -ItemType Directory -Path (Join-Path $home_ '.cursor') -Force | Out-Null
$r = Invoke-Install '-Agent cursor'
Check 'cursor: clones into a profile with a space and an accent' ($r.Code -eq 0 -and $r.Out -match 'result cursor installed' -and (Test-Path (Join-Path $home_ '.cursor\plugins\local\postman\.cursor-plugin\plugin.json'))) "$($r.Code) $($r.Out)"
$r = Invoke-Install '-Agent cursor'
Check 'cursor: second run is already-installed' ($r.Out -match 'result cursor already-installed') $r.Out

New-Scenario '[]' '[]' ''
Remove-Item (Join-Path $home_ '.cursor') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$bin\*.cmd" -Force
$r = Invoke-Install ''
Check 'no agent: exit 3' ($r.Code -eq 3 -and $r.Out -match 'No supported agent found') "$($r.Code) $($r.Out)"

$r = Invoke-Install '-Agent vim'
Check 'bad agent: exit 2' ($r.Code -eq 2 -and $r.Out -match 'Usage') "$($r.Code) $($r.Out)"

# A Restricted policy refuses name.ps1, which npm installs next to name.cmd, and PowerShell prefers the .ps1.
New-Scenario '[]' '[]' ''
Set-Content -Path (Join-Path $bin 'claude.ps1') -Value 'Write-Host "ps1 shim ran"; exit 9' -Encoding ASCII
$r = Invoke-Install '-Agent claude-code' '' 'iex' '' 'Restricted'
Check 'Restricted policy: runs the .cmd, not the .ps1 shim' ($r.Code -eq 0 -and $r.Out -match 'result claude-code installed' -and $r.Out -notmatch 'ps1 shim ran|disabled on this system') "$($r.Code) $($r.Out)"

# Language mode: a managed machine can run the script in Constrained Language Mode.
New-Scenario '[]' '[]' ''
$r = Invoke-Install '-Agent claude-code' '' 'iex' '$ExecutionContext.SessionState.LanguageMode = ''ConstrainedLanguage''; Write-Host (''mode='' + $ExecutionContext.SessionState.LanguageMode); '
Check 'Constrained Language Mode: still installs' ($r.Out -match 'mode=ConstrainedLanguage' -and $r.Out -match 'result claude-code installed') "$($r.Code) $($r.Out)"

# iex mode: the session survives and $LASTEXITCODE carries the result
New-Scenario '[]' '[]' ''
$r = Invoke-Install '' "`$env:POSTMAN_PLUGIN_AGENT='claude-code,codex'" 'iex' '' 'Bypass'
Check 'iex: runs, reads POSTMAN_PLUGIN_AGENT, exits 0' ($r.Code -eq 0 -and $r.Out -match 'result claude-code installed' -and $r.Out -match 'result codex installed') "$($r.Code) $($r.Out)"
$r = Invoke-Install '' "`$env:POSTMAN_PLUGIN_AGENT='vim'" 'iex'
Check 'iex: bad agent sets code 2' ($r.Code -eq 2) "$($r.Code) $($r.Out)"
$probe = & $ps -NoProfile -ExecutionPolicy Bypass -Command "`$env:PATH='$bin;$env:SystemRoot\System32'; `$env:USERPROFILE='$home_'; `$env:POSTMAN_PLUGIN_AGENT='claude-code'; Get-Content -Raw '$script' | iex; 'alive'; `$leak = (Get-Variable Repo,GitUrl,st,ctx -ErrorAction SilentlyContinue | Measure-Object).Count; 'leaked=' + `$leak" 2>&1 | Out-String
Check 'iex: session stays open and no variable leaks' ($probe -match 'alive' -and $probe -match 'leaked=0') $probe

# Telemetry goes to a local listener. Returns the bodies of the events one run sends.
function Get-Events($agentArgs, $envs, $count = 1) {
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://127.0.0.1:$port/")
    $listener.Start()
    $events = @()
    try {
        $job = Start-Job -ScriptBlock {
            param($ps, $script, $bin, $home_, $root, $agentArgs, $envs)
            $env:PATH = "$bin;$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:ProgramFiles\Git\cmd"
            $env:USERPROFILE = $home_
            $env:POSTMAN_PLUGIN_CURSOR_APP = "$root\none"
            $out = & $ps -NoProfile -ExecutionPolicy Bypass -Command "$envs; & '$script' $agentArgs; exit `$LASTEXITCODE" 2>&1 | Out-String
            @{ Code = $LASTEXITCODE; Out = $out }
        } -ArgumentList $ps, $script, $bin, $home_, $root, $agentArgs, $envs
        for ($i = 0; $i -lt $count; $i++) {
            $pending = $listener.GetContextAsync()
            if (-not $pending.Wait(20000)) { break }
            $ctx = $pending.Result
            $events += (New-Object IO.StreamReader($ctx.Request.InputStream)).ReadToEnd()
            $ctx.Response.StatusCode = 200
            $ctx.Response.Close()
        }
        $result = Wait-Job $job -Timeout 30 | Receive-Job
        Remove-Job $job -Force
        $script:LastRun = $result
    } finally { $listener.Stop() }
    return $events
}

$tel = "`$env:POSTMAN_PLUGIN_TELEMETRY_URL='http://127.0.0.1:$port/store'"

New-Scenario '[]' $official 'plugin install' 'getaddrinfo ENOTFOUND github.com C:\Users\someone\secret'
$e = (Get-Events '-Agent claude-code' "$tel; `$env:POSTMAN_PLUGIN_INSTALL_SOURCE='auto new/download;x'") -join ''
Check 'telemetry: failure has cause, exit code, versions, run id, source, host facts' (
    $e -match '"reason":\s*"install-failed"' -and $e -match '"cause":\s*"network-dns"' -and $e -match '"exit_code":\s*"1"' -and
    $e -match '"agent_version":\s*"2\.1\.296 Agent Name"' -and $e -match '"run_id":\s*"[0-9a-f]{12}"' -and
    $e -match '"source":\s*"auto_new_download_x"' -and $e -match '"ps_version":\s*"\d' -and $e -match '"exec_policy":' -and
    $e -match '"language_mode":\s*"FullLanguage"' -and $e -match '"via":\s*"file"' -and $e -match '"arch":') $e
Check 'telemetry: nothing the agent printed or any path is sent' ($e -notmatch 'secret|someone|ENOTFOUND|github\.com|Users') $e

foreach ($case in @(
    @('x509: certificate signed by unknown authority', 'tls'),
    @('HTTP 407 Proxy Authentication Required', 'proxy'),
    @('Access is denied', 'permission'),
    @('There is not enough space on the disk', 'disk-full'),
    @('fatal: could not read Username: terminal prompts disabled', 'auth'),
    @('error: unknown option --scope', 'cli-unsupported'),
    @('something nobody has seen', 'unknown'))) {
    New-Scenario '[]' $official 'plugin install' $case[0]
    $e = (Get-Events '-Agent claude-code' $tel) -join ''
    Check "telemetry: cause for '$($case[0])' is $($case[1])" ($e -match "`"cause`":\s*`"$($case[1])`"") $e
}

New-Scenario '[]' '[]' ''
Remove-Item "$bin\*.cmd" -Force
$e = (Get-Events '' $tel) -join ''
Check 'telemetry: no supported agent is reported' ($e -match '"agent":\s*"none"' -and $e -match '"reason":\s*"no-agent"') $e

# An unexpected exception: no LOCALAPPDATA and no override makes the Cursor path join throw.
New-Scenario '[]' '[]' ''
$e = (Get-Events '-Agent cursor' "$tel; `$env:POSTMAN_PLUGIN_CURSOR_APP=`$null; Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue") -join ''
Check 'telemetry: an unexpected exception is reported by type, exit 4' ($e -match '"reason":\s*"crashed-\w+"' -and $script:LastRun.Code -eq 4) "$e $($script:LastRun.Out)"

# Environment, grouping and message
New-Scenario '[]' $official 'plugin install' 'getaddrinfo ENOTFOUND'
$e = (Get-Events '-Agent claude-code' $tel) -join ''
Check 'telemetry: environment defaults to production, fingerprint and message carry the reason' (
    $e -match '"environment":\s*"production"' -and $e -match '"message":\s*"postman-plugin-install claude-code failed install-failed network-dns"' -and
    $e -match '"fingerprint":\s*\[\s*"postman-plugin-install",\s*"claude-code",\s*"failed",\s*"install-failed",\s*"network-dns"\s*\]') $e
New-Scenario '[]' '[]' ''
$e = (Get-Events '-Agent claude-code' "$tel; `$env:POSTMAN_PLUGIN_ENVIRONMENT='beta;x'") -join ''
Check 'telemetry: environment comes from POSTMAN_PLUGIN_ENVIRONMENT, sanitized' ($e -match '"environment":\s*"beta_x"') $e

# Cursor: detected from its real install folder, cloned beside the target, and never left half done
$fakeLocal = Join-Path $root 'local'
New-Scenario '[]' '[]' ''
New-Item -ItemType Directory -Path (Join-Path $fakeLocal 'Programs\cursor') -Force | Out-Null
Remove-Item (Join-Path $home_ '.cursor') -Recurse -Force -ErrorAction SilentlyContinue
Set-Content -Path (Join-Path $bin 'git.cmd') -Value @('@echo off', "echo git %* >> `"$log`"", 'echo %* | findstr /C:"--version" >nul && (echo git version 2.0 & exit /b 0)', 'echo fatal: unable to access 1>&2', 'exit /b 128') -Encoding ASCII
$r = Invoke-Install '-Agent cursor' "`$env:LOCALAPPDATA='$fakeLocal'; `$env:POSTMAN_PLUGIN_CURSOR_APP=`$null"
Check 'cursor: found by %LOCALAPPDATA%\Programs\cursor, a failed clone leaves nothing' ($r.Out -match 'result cursor failed clone-failed' -and -not (Test-Path (Join-Path $home_ '.cursor\plugins\local\postman*'))) "$($r.Code) $($r.Out)"
New-Item -ItemType Directory -Path (Join-Path $home_ '.cursor\plugins\local\postman.partial') -Force | Out-Null
Set-Content -Path (Join-Path $home_ '.cursor\plugins\local\postman.partial\stale.txt') -Value x
Remove-Item (Join-Path $bin 'git.cmd')
$r = Invoke-Install '-Agent cursor' "`$env:LOCALAPPDATA='$fakeLocal'; `$env:POSTMAN_PLUGIN_CURSOR_APP=`$null; `$env:PATH=`$env:PATH + ';$env:ProgramFiles\Git\cmd'"
Check 'cursor: a leftover partial folder is replaced by a real clone' ($r.Out -match 'result cursor installed' -and (Test-Path (Join-Path $home_ '.cursor\plugins\local\postman\.cursor-plugin\plugin.json')) -and -not (Test-Path (Join-Path $home_ '.cursor\plugins\local\postman.partial'))) "$($r.Code) $($r.Out)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "FAILS=$fails"
if ($fails -gt 0) { exit 1 }
exit 0
