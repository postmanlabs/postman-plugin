# Installs the Postman plugin into Claude Code, Codex and Cursor using each agent's own CLI.
# It needs no Node. `npx @postman/postman-plugin` covers every other agent.
#
#   irm https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/install/install.ps1 | iex
#   $env:POSTMAN_PLUGIN_AGENT = 'claude-code,codex'; irm https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/install/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Agent claude-code,codex
#
# Piped to iex it sets $LASTEXITCODE and leaves your session open. POSTMAN_PLUGIN_AGENT limits the run there.
#
# An installed plugin is left alone, never updated. Exit codes: 0 done, 1 an agent failed,
# 2 bad usage, 3 no supported agent found, 4 the script itself broke. The last lines are
# `result <agent> <outcome> [reason]`.
#
# POSTMAN_PLUGIN_INSTALL_SOURCE and POSTMAN_PLUGIN_ENVIRONMENT (default production) tag the telemetry
# event (a-z, 0-9, _ and -, 40 and 20 characters).
# POSTMAN_PLUGIN_TELEMETRY=0 turns telemetry off. An event holds fixed codes and version strings
# only, never agent output, paths or user text.
# Same behavior as install.sh. Keep the two in step.

param([string[]]$Agent)

function Install-PostmanPlugin {
    param([string[]]$Agent)

    # A native command that writes to stderr must not become a terminating error in Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'

    $Repo = 'postmanlabs/postman-plugin'
    $GitUrl = "https://github.com/$Repo.git"
    $Branch = 'main'
    $ClaudeMarketplace = 'claude-plugins-official'
    $ClaudeRepo = 'anthropics/claude-plugins-official'
    $ClaudePlugin = "postman@$ClaudeMarketplace"
    $CodexMarketplace = 'postman'
    $CodexPlugin = "postman@$CodexMarketplace"
    $ScriptVersion = '2'
    # Sentry store endpoint of the plugin installer project. Empty sends nothing.
    $TelemetryUrl = $env:POSTMAN_PLUGIN_TELEMETRY_URL

    $Source = ''
    if ($env:POSTMAN_PLUGIN_INSTALL_SOURCE) {
        $Source = ($env:POSTMAN_PLUGIN_INSTALL_SOURCE -replace '[^a-zA-Z0-9_-]', '_')
        if ($Source.Length -gt 40) { $Source = $Source.Substring(0, 40) }
    }

    # Tells a beta app's installs from production ones, the way the CLI installer tags its channel.
    $Environment = if ($env:POSTMAN_PLUGIN_ENVIRONMENT) { $env:POSTMAN_PLUGIN_ENVIRONMENT -replace '[^a-zA-Z0-9_-]', '_' } else { 'production' }
    if ($Environment.Length -gt 20) { $Environment = $Environment.Substring(0, 20) }

    # One hashtable, so the helpers below share state without touching the caller's scope under iex.
    $st = @{ Outcome = ''; Reason = ''; Cause = ''; ExitCode = ''; AgentVersion = ''; Detected = $false; Agent = ''; Done = $false }

    # A background install has no terminal, so a credential prompt would hang until the caller gives up.
    $env:GIT_TERMINAL_PROMPT = '0'

    # Every value below is safe to send: a fixed word, a number or a version string.
    function Get-Safe($fn) { try { & $fn } catch { '' } }
    $ctx = @{
        run_id         = [guid]::NewGuid().ToString('N').Substring(0, 12)
        ps_version     = (Get-Safe { $PSVersionTable.PSVersion.ToString() })
        ps_edition     = (Get-Safe { [string]$PSVersionTable.PSEdition })
        language_mode  = (Get-Safe { $ExecutionContext.SessionState.LanguageMode.ToString() })
        exec_policy    = (Get-Safe { (Get-ExecutionPolicy).ToString() })
        arch           = (Get-Safe { [string]$env:PROCESSOR_ARCHITECTURE })
        os_version     = (Get-Safe { [Environment]::OSVersion.Version.ToString() })
        via            = $(if ($PSCommandPath) { 'file' } else { 'iex' })
    }

    # Windows PowerShell 5.1 can default to TLS 1.0, which the telemetry endpoint refuses.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    function Write-Err($message) {
        try { [Console]::Error.WriteLine($message) } catch { Write-Host $message }
    }

    function Has-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

    # npm installs an agent as name.ps1 and name.cmd, and PowerShell prefers the .ps1, which a
    # Restricted execution policy refuses to run. Resolving to an application picks the .exe or .cmd.
    function Resolve-Agent($name) {
        $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.Source }
        return $null
    }

    # Fixed codes and version strings only: a Sentry event must never carry paths, agent output or user text.
    # The fingerprint keeps each failure kind its own Sentry issue instead of one issue per agent.
    function Send-Report($agentName, $outcome, $reason, $e) {
        if (-not $TelemetryUrl -or $env:POSTMAN_PLUGIN_TELEMETRY -eq '0') { return }
        $tags = @{ agent = $agentName; outcome = $outcome; environment = $Environment; os = 'windows'; script_version = $ScriptVersion }
        foreach ($key in $ctx.Keys) { if ($ctx[$key]) { $tags[$key] = [string]$ctx[$key] } }
        if ($reason) { $tags.reason = $reason }
        if ($e.Cause) { $tags.cause = $e.Cause }
        if ($e.ExitCode -ne '') { $tags.exit_code = [string]$e.ExitCode }
        if ($e.AgentVersion) { $tags.agent_version = $e.AgentVersion }
        if ($Source) { $tags.source = $Source }
        $why = $(if ($reason) { " $reason" } else { '' }) + $(if ($e.Cause) { " $($e.Cause)" } else { '' })
        $body = @{
            message     = "postman-plugin-install $agentName $outcome$why"
            level       = $(if ($outcome -eq 'failed') { 'error' } else { 'info' })
            logger      = 'postman-plugin-install'
            platform    = 'other'
            fingerprint = @('postman-plugin-install', $agentName, $outcome, [string]$reason, [string]$e.Cause)
            tags        = $tags
        } | ConvertTo-Json -Depth 4 -Compress
        try {
            Invoke-RestMethod -Uri $TelemetryUrl -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
        } catch { }
    }

    # Events are queued and sent after the result lines are printed, so a slow or blocked Sentry cannot delay them.
    # A plain array: Constrained Language Mode refuses New-Object for a .NET collection type.
    $queue = @{ Items = @() }
    function Add-Pending($agentName, $outcome, $reason) {
        $queue.Items += , @{ Agent = $agentName; Outcome = $outcome; Reason = $reason; E = @{ Cause = $st.Cause; ExitCode = $st.ExitCode; AgentVersion = $st.AgentVersion } }
    }
    function Send-Pending {
        $items = $queue.Items
        $queue.Items = @()
        foreach ($item in $items) { Send-Report $item.Agent $item.Outcome $item.Reason $item.E }
    }

    # Maps a failed command's output to a fixed code, so a failure is diagnosable without sending the output.
    function Get-Cause($text) {
        $t = $text.ToLowerInvariant()
        if ($t -match 'no space left|enospc|not enough space|not enough disk') { return 'disk-full' }
        if ($t -match 'could not resolve|name or service not known|enotfound|getaddrinfo|no such host|network is unreachable|temporary failure in name') { return 'network-dns' }
        if ($t -match 'proxy authentication| 407|proxy error|tunnel connection failed') { return 'proxy' }
        if ($t -match 'certificate|ssl |tls |unable to get local issuer|schannel') { return 'tls' }
        if ($t -match 'timed out|timeout|etimedout') { return 'network-timeout' }
        if ($t -match 'rate limit| 429|too many requests') { return 'rate-limited' }
        if ($t -match 'terminal prompts disabled|could not read username|authentication failed|not logged in|please sign in|please log in') { return 'auth' }
        if ($t -match 'permission denied|eacces|operation not permitted|access is denied|being used by another process') { return 'permission' }
        if ($t -match 'filename too long|path too long|path.*too long') { return 'path-too-long' }
        if ($t -match 'unknown option|unrecognized|unexpected argument|unknown command|no such command|invalid command') { return 'cli-unsupported' }
        if ($t -match 'another process|already running|lock file|resource busy') { return 'busy' }
        return 'unknown'
    }

    # Runs a command and shows its output only when it fails. Returns $true on exit code 0.
    function Invoke-Agent($exe, [string[]]$arguments) {
        $out = & $exe @arguments 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $st.ExitCode = $LASTEXITCODE
            $st.Cause = Get-Cause $out
            Write-Err $out.TrimEnd()
            return $false
        }
        return $true
    }

    # The agent's own version string, kept to a safe character set.
    function Get-AgentVersion($exe) {
        try {
            $v = (& $exe --version 2>$null | Select-Object -First 1 | Out-String).Trim()
            $v = $v -replace '[^a-zA-Z0-9._ -]', ''
            if ($v.Length -gt 30) { $v = $v.Substring(0, 30) }
            return $v
        } catch { return '' }
    }

    function Finish($outcome, $reason = '') {
        $st.Outcome = $outcome
        $st.Reason = $reason
    }

    function Install-ClaudeCode {
        $claude = Resolve-Agent 'claude'
        if (-not $claude) { return $false }
        $st.Detected = $true
        $st.AgentVersion = Get-AgentVersion $claude

        $plugins = & $claude plugin list --json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0) { $st.ExitCode = $LASTEXITCODE; Finish 'failed' 'list-failed'; return $true }
        # postman@postman is the same plugin from our own marketplace; adding the official one would load it twice.
        if ($plugins -match "`"id`"\s*:\s*`"($([regex]::Escape($ClaudePlugin))|postman@postman)`"") {
            Finish 'already-installed'; return $true
        }

        $marketplaces = & $claude plugin marketplace list --json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0) { $st.ExitCode = $LASTEXITCODE; Finish 'failed' 'list-failed'; return $true }
        if ($marketplaces -match "`"name`"\s*:\s*`"$([regex]::Escape($ClaudeMarketplace))`"") {
            if ($marketplaces -notmatch [regex]::Escape($ClaudeRepo)) { Finish 'failed' 'marketplace-source-mismatch'; return $true }
            # A stale marketplace would install an old release. Refreshing it is best effort.
            & $claude plugin marketplace update $ClaudeMarketplace *> $null
        } elseif (-not (Invoke-Agent $claude @('plugin', 'marketplace', 'add', $ClaudeRepo, '--scope', 'user'))) {
            Finish 'failed' 'marketplace-add-failed'; return $true
        }

        if (-not (Invoke-Agent $claude @('plugin', 'install', $ClaudePlugin, '--scope', 'user'))) {
            Finish 'failed' 'install-failed'; return $true
        }
        Finish 'installed'
        return $true
    }

    function Install-Codex {
        $codex = Resolve-Agent 'codex'
        if (-not $codex) { return $false }
        $st.Detected = $true
        $st.AgentVersion = Get-AgentVersion $codex

        $plugins = & $codex plugin list --json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0) { $st.ExitCode = $LASTEXITCODE; Finish 'failed' 'list-failed'; return $true }
        if ($plugins -match "`"pluginId`"\s*:\s*`"$([regex]::Escape($CodexPlugin))`"") { Finish 'already-installed'; return $true }

        $marketplaces = & $codex plugin marketplace list --json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0) { $st.ExitCode = $LASTEXITCODE; Finish 'failed' 'list-failed'; return $true }
        if ($marketplaces -match "`"name`"\s*:\s*`"$([regex]::Escape($CodexMarketplace))`"") {
            if ($marketplaces -notmatch [regex]::Escape($Repo)) { Finish 'failed' 'marketplace-source-mismatch'; return $true }
            & $codex plugin marketplace upgrade $CodexMarketplace --json *> $null
        } elseif (-not (Invoke-Agent $codex @('plugin', 'marketplace', 'add', $Repo, '--json'))) {
            Finish 'failed' 'marketplace-add-failed'; return $true
        }

        if (-not (Invoke-Agent $codex @('plugin', 'add', $CodexPlugin, '--json'))) { Finish 'failed' 'install-failed'; return $true }
        Finish 'installed'
        return $true
    }

    # Cursor has no install command. Its editor loads any plugin folder under plugins/local.
    function Install-Cursor {
        $cursorDir = Join-Path $env:USERPROFILE '.cursor'
        $cursorApp = if ($env:POSTMAN_PLUGIN_CURSOR_APP) { $env:POSTMAN_PLUGIN_CURSOR_APP } else { Join-Path $env:LOCALAPPDATA 'Programs\cursor' }
        if (-not ((Has-Command 'cursor') -or (Has-Command 'cursor-agent') -or (Test-Path $cursorDir) -or (Test-Path $cursorApp))) {
            return $false
        }
        $st.Detected = $true

        $clone = Join-Path $cursorDir 'plugins\local\postman'
        if ((Test-Path (Join-Path $clone '.cursor-plugin\plugin.json')) -or (Test-Path (Join-Path $cursorDir 'plugins\cache\cursor-public\postman'))) {
            Finish 'already-installed'; return $true
        }
        if (Test-Path $clone) { Finish 'failed' 'target-exists'; return $true }
        $git = Resolve-Agent 'git'
        if (-not $git) { Finish 'failed' 'git-missing'; return $true }
        $st.AgentVersion = Get-AgentVersion $git

        # Cloned beside the target and renamed, so a run that is killed halfway leaves nothing Cursor could load.
        # The partial folder is ours alone, so a leftover one is removed first. A long username plus the plugin
        # tree can pass the 260 character limit unless Git's long path support is on.
        $partial = "$clone.partial"
        if (Test-Path $partial) { Remove-Item $partial -Recurse -Force -ErrorAction SilentlyContinue }
        if (-not (Invoke-Agent $git @('-c', 'core.longpaths=true', 'clone', '--depth', '1', '--branch', $Branch, $GitUrl, $partial))) {
            Remove-Item $partial -Recurse -Force -ErrorAction SilentlyContinue
            Finish 'failed' 'clone-failed'; return $true
        }
        try { Move-Item -LiteralPath $partial -Destination $clone -ErrorAction Stop } catch {
            Remove-Item $partial -Recurse -Force -ErrorAction SilentlyContinue
            Finish 'failed' 'clone-failed'; return $true
        }
        Finish 'installed'
        return $true
    }

    function Invoke-Run {
        if (-not $Agent -and $env:POSTMAN_PLUGIN_AGENT) { $Agent = $env:POSTMAN_PLUGIN_AGENT -split ',' | ForEach-Object { $_.Trim() } }
        $agents = if ($Agent) { $Agent } else { @('claude-code', 'codex', 'cursor') }
        foreach ($name in $agents) {
            if ($name -notin 'claude-code', 'codex', 'cursor') {
                Write-Err 'Usage: install.ps1 [-Agent claude-code,codex,cursor]'
                return 2
            }
        }
        if (-not $env:USERPROFILE) {
            Write-Err 'USERPROFILE is not set'
            return 2
        }

        $failed = $false
        $results = @()
        foreach ($name in $agents) {
            $st.Outcome = ''; $st.Reason = ''; $st.Cause = ''; $st.ExitCode = ''; $st.AgentVersion = ''
            $st.Agent = $name
            $ran = switch ($name) {
                'claude-code' { Install-ClaudeCode }
                'codex' { Install-Codex }
                'cursor' { Install-Cursor }
            }
            if (-not $ran) { continue }

            $suffix = if ($st.Reason) { " ($($st.Reason))" } else { '' }
            Write-Host "  ${name}: $($st.Outcome)$suffix"
            $results += "result $name $($st.Outcome)$(if ($st.Reason) { " $($st.Reason)" })"
            Add-Pending $name $st.Outcome $st.Reason
            if ($st.Outcome -eq 'failed') { $failed = $true }
        }
        $st.Agent = ''

        if (-not $st.Detected) {
            Write-Err 'No supported agent found. Install Claude Code, Codex or Cursor, or run npx @postman/postman-plugin.'
            $st.Outcome = 'skipped'; $st.Cause = ''; $st.ExitCode = ''; $st.AgentVersion = ''
            Send-Report 'none' 'skipped' 'no-agent' @{ Cause = ''; ExitCode = ''; AgentVersion = '' }
            return 3
        }

        $results | ForEach-Object { Write-Host $_ }
        Send-Pending
        if ($failed) { return 1 }
        return 0
    }

    # Anything the steps above did not expect is reported by its .NET type name, which is a fixed word.
    try {
        return (Invoke-Run)
    } catch {
        $st.Outcome = 'failed'; $st.Cause = ''; $st.ExitCode = ''; $st.AgentVersion = ''
        $type = Get-Safe { $_.Exception.GetType().Name }
        Send-Report $(if ($st.Agent) { $st.Agent } else { 'script' }) 'failed' "crashed-$type" @{ Cause = ''; ExitCode = ''; AgentVersion = '' }
        Write-Err 'The Postman plugin installer hit an unexpected error.'
        return 4
    }
}

# Run as a file, `exit` ends only this process. Piped to iex it would close the caller's window, so set the code and return.
$code = Install-PostmanPlugin -Agent $Agent
if ($PSCommandPath) { exit $code }
$global:LASTEXITCODE = $code
