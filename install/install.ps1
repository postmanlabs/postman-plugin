# Installs the Postman plugin into Claude Code, Codex and Cursor using each agent's own CLI.
# It needs no Node. `npx @postman/postman-plugin` covers every other agent.
#
#   irm https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/install/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Agent claude-code,codex
#
# An installed plugin is left alone, never updated. Exit codes: 0 done, 1 an agent failed,
# 2 bad usage, 3 no supported agent found. The last lines are `result <agent> <outcome> [reason]`.
#
# POSTMAN_PLUGIN_INSTALL_SOURCE tags the telemetry event (a-z, 0-9, _ and -, 40 characters).
# POSTMAN_PLUGIN_TELEMETRY=0 turns telemetry off. An event holds fixed codes only, never agent output.
# Same behavior as install.sh. Keep the two in step.

param(
    [ValidateSet('claude-code', 'codex', 'cursor')]
    [string[]]$Agent
)

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
$ScriptVersion = '1'
# Sentry store endpoint of the plugin installer project. Empty sends nothing.
$TelemetryUrl = $env:POSTMAN_PLUGIN_TELEMETRY_URL

$Source = ''
if ($env:POSTMAN_PLUGIN_INSTALL_SOURCE) {
    $Source = ($env:POSTMAN_PLUGIN_INSTALL_SOURCE -replace '[^a-zA-Z0-9_-]', '_')
    if ($Source.Length -gt 40) { $Source = $Source.Substring(0, 40) }
}

$script:Outcome = ''
$script:Reason = ''
$script:Failed = $false
$script:Detected = $false
$script:Results = @()

function Has-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Fixed codes only: a Sentry event must never carry paths, agent output or user text.
function Send-Report($agentName, $outcome, $reason) {
    if (-not $TelemetryUrl -or $env:POSTMAN_PLUGIN_TELEMETRY -eq '0') { return }
    $tags = @{ agent = $agentName; outcome = $outcome; os = 'windows'; script_version = $ScriptVersion }
    if ($reason) { $tags.reason = $reason }
    if ($Source) { $tags.source = $Source }
    $body = @{
        message  = "postman-plugin-install $agentName $outcome"
        level    = $(if ($outcome -eq 'failed') { 'error' } else { 'info' })
        logger   = 'postman-plugin-install'
        platform = 'other'
        tags     = $tags
    } | ConvertTo-Json -Depth 4 -Compress
    try {
        Invoke-RestMethod -Uri $TelemetryUrl -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
    } catch { }
}

# Runs a command and shows its output only when it fails. Returns $true on exit code 0.
function Invoke-Agent($exe, [string[]]$arguments) {
    $out = & $exe @arguments 2>&1 | Out-String
    $script:LastOutput = $out
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine($out.TrimEnd())
        return $false
    }
    return $true
}

function Finish($outcome, $reason = '') {
    $script:Outcome = $outcome
    $script:Reason = $reason
}

function Install-ClaudeCode {
    if (-not (Has-Command 'claude')) { return $false }
    $script:Detected = $true

    $plugins = & claude plugin list --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { Finish 'failed' 'list-failed'; return $true }
    # postman@postman is the same plugin from our own marketplace; adding the official one would load it twice.
    if ($plugins -match "`"id`"\s*:\s*`"($([regex]::Escape($ClaudePlugin))|postman@postman)`"") {
        Finish 'already-installed'; return $true
    }

    $marketplaces = & claude plugin marketplace list --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { Finish 'failed' 'list-failed'; return $true }
    if ($marketplaces -match "`"name`"\s*:\s*`"$([regex]::Escape($ClaudeMarketplace))`"") {
        if ($marketplaces -notmatch [regex]::Escape($ClaudeRepo)) { Finish 'failed' 'marketplace-source-mismatch'; return $true }
        # A stale marketplace would install an old release. Refreshing it is best effort.
        & claude plugin marketplace update $ClaudeMarketplace *> $null
    } elseif (-not (Invoke-Agent 'claude' @('plugin', 'marketplace', 'add', $ClaudeRepo, '--scope', 'user'))) {
        Finish 'failed' 'marketplace-add-failed'; return $true
    }

    if (-not (Invoke-Agent 'claude' @('plugin', 'install', $ClaudePlugin, '--scope', 'user'))) {
        Finish 'failed' 'install-failed'; return $true
    }
    Finish 'installed'
    return $true
}

function Install-Codex {
    if (-not (Has-Command 'codex')) { return $false }
    $script:Detected = $true

    $plugins = & codex plugin list --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { Finish 'failed' 'list-failed'; return $true }
    if ($plugins -match "`"pluginId`"\s*:\s*`"$([regex]::Escape($CodexPlugin))`"") { Finish 'already-installed'; return $true }

    $marketplaces = & codex plugin marketplace list --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { Finish 'failed' 'list-failed'; return $true }
    if ($marketplaces -match "`"name`"\s*:\s*`"$([regex]::Escape($CodexMarketplace))`"") {
        if ($marketplaces -notmatch [regex]::Escape($Repo)) { Finish 'failed' 'marketplace-source-mismatch'; return $true }
        & codex plugin marketplace upgrade $CodexMarketplace --json *> $null
    } elseif (-not (Invoke-Agent 'codex' @('plugin', 'marketplace', 'add', $Repo, '--json'))) {
        Finish 'failed' 'marketplace-add-failed'; return $true
    }

    if (-not (Invoke-Agent 'codex' @('plugin', 'add', $CodexPlugin, '--json'))) { Finish 'failed' 'install-failed'; return $true }
    Finish 'installed'
    return $true
}

# Cursor has no install command. Its editor loads any plugin folder under plugins/local.
function Install-Cursor {
    $home_ = $HOME
    $cursorDir = Join-Path $home_ '.cursor'
    $cursorApp = if ($env:POSTMAN_PLUGIN_CURSOR_APP) { $env:POSTMAN_PLUGIN_CURSOR_APP } else { Join-Path $env:LOCALAPPDATA 'Programs\cursor' }
    if (-not ((Has-Command 'cursor') -or (Has-Command 'cursor-agent') -or (Test-Path $cursorDir) -or (Test-Path $cursorApp))) {
        return $false
    }
    $script:Detected = $true

    $clone = Join-Path $cursorDir 'plugins\local\postman'
    if ((Test-Path (Join-Path $clone '.cursor-plugin\plugin.json')) -or (Test-Path (Join-Path $cursorDir 'plugins\cache\cursor-public\postman'))) {
        Finish 'already-installed'; return $true
    }
    if (Test-Path $clone) { Finish 'failed' 'target-exists'; return $true }
    if (-not (Has-Command 'git')) { Finish 'failed' 'git-missing'; return $true }

    if (-not (Invoke-Agent 'git' @('clone', '--depth', '1', '--branch', $Branch, $GitUrl, $clone))) { Finish 'failed' 'clone-failed'; return $true }
    Finish 'installed'
    return $true
}

$agents = if ($Agent) { $Agent } else { @('claude-code', 'codex', 'cursor') }

foreach ($name in $agents) {
    $script:Outcome = ''
    $script:Reason = ''
    $ran = switch ($name) {
        'claude-code' { Install-ClaudeCode }
        'codex' { Install-Codex }
        'cursor' { Install-Cursor }
    }
    if (-not $ran) { continue }

    $suffix = if ($script:Reason) { " ($($script:Reason))" } else { '' }
    Write-Host "  ${name}: $($script:Outcome)$suffix"
    $script:Results += "result $name $($script:Outcome)$(if ($script:Reason) { " $($script:Reason)" })"
    Send-Report $name $script:Outcome $script:Reason
    if ($script:Outcome -eq 'failed') { $script:Failed = $true }
}

if (-not $script:Detected) {
    [Console]::Error.WriteLine('No supported agent found. Install Claude Code, Codex or Cursor, or run npx @postman/postman-plugin.')
    exit 3
}

$script:Results | ForEach-Object { Write-Host $_ }
if ($script:Failed) { exit 1 }
exit 0
