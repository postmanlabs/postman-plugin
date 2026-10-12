#!/bin/sh
# Installs the Postman plugin into Claude Code, Codex and Cursor using each agent's own CLI.
# It needs no Node. `npx @postman/postman-plugin` covers every other agent.
#
#   curl -fsSL https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/install/install.sh | sh
#   sh install.sh --agent claude-code --agent codex
#
# An installed plugin is left alone, never updated. Exit codes: 0 done, 1 an agent failed,
# 2 bad usage, 3 no supported agent found, 4 the script itself broke. The last lines are
# `result <agent> <outcome> [reason]`.
#
# POSTMAN_PLUGIN_INSTALL_SOURCE and POSTMAN_PLUGIN_ENVIRONMENT (default production) tag the telemetry
# event (a-z, 0-9, _ and -, 40 and 20 characters).
# POSTMAN_PLUGIN_TELEMETRY=0 turns telemetry off. An event holds fixed codes and version strings
# only, never agent output, paths or user text.

set -u

REPO='postmanlabs/postman-plugin'
GIT_URL="https://github.com/$REPO.git"
BRANCH='main'
CLAUDE_MARKETPLACE='claude-plugins-official'
CLAUDE_REPO='anthropics/claude-plugins-official'
CLAUDE_PLUGIN="postman@$CLAUDE_MARKETPLACE"
CODEX_MARKETPLACE='postman'
CODEX_PLUGIN="postman@$CODEX_MARKETPLACE"
SCRIPT_VERSION='2'
# The plugin installer's Sentry project. The key is a public ingest key that can only send events.
# POSTMAN_PLUGIN_TELEMETRY_URL replaces it, POSTMAN_PLUGIN_TELEMETRY=0 turns reporting off.
TELEMETRY_URL="${POSTMAN_PLUGIN_TELEMETRY_URL:-https://o1224273.ingest.us.sentry.io/api/4512245392867328/store/?sentry_key=89624d613f8f105a75eaf131a319a2a6}"
# Overridable only so tests do not find a Cursor installed on the machine running them.
CURSOR_APP="${POSTMAN_PLUGIN_CURSOR_APP:-/Applications/Cursor.app}"

# A background install has no terminal, so a credential prompt would hang until the caller gives up.
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT

clean() { tr -cd 'a-zA-Z0-9._ -' | cut -c1-"$1"; }

SOURCE=$(printf '%s' "${POSTMAN_PLUGIN_INSTALL_SOURCE:-}" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-40)
# Tells a beta app's installs from production ones, the way the CLI installer tags its channel.
ENVIRONMENT=$(printf '%s' "${POSTMAN_PLUGIN_ENVIRONMENT:-production}" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-20)
OS=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m 2>/dev/null | clean 20)
OS_VERSION=$(uname -r 2>/dev/null | clean 40)
RUN_ID="$(date +%s 2>/dev/null)-$$"
HOME_DIR="${HOME:-}"

OUTCOME=''
REASON=''
CAUSE=''
EXIT_CODE=''
AGENT_VERSION=''
FAILED=0
DETECTED=0
DONE=0
ABORTED=0
RESULTS=''
PENDING=''
CURRENT_AGENT=''

usage() {
    printf 'Usage: install.sh [--agent claude-code|codex|cursor]...\n' >&2
    DONE=1
    exit 2
}

# Fixed codes and version strings only: a Sentry event must never carry paths, agent output or user text.
# The fingerprint keeps each failure kind its own Sentry issue instead of one issue per agent.
report() {
    [ -n "$TELEMETRY_URL" ] || return 0
    [ "${POSTMAN_PLUGIN_TELEMETRY:-1}" = 0 ] && return 0
    command -v curl >/dev/null 2>&1 || return 0
    level=info
    [ "$2" = failed ] && level=error
    tags="\"agent\":\"$1\",\"outcome\":\"$2\",\"environment\":\"$ENVIRONMENT\",\"os\":\"$OS\",\"arch\":\"$ARCH\",\"os_version\":\"$OS_VERSION\",\"script_version\":\"$SCRIPT_VERSION\",\"run_id\":\"$RUN_ID\""
    [ -n "$3" ] && tags="$tags,\"reason\":\"$3\""
    [ -n "$CAUSE" ] && tags="$tags,\"cause\":\"$CAUSE\""
    [ -n "$EXIT_CODE" ] && tags="$tags,\"exit_code\":\"$EXIT_CODE\""
    [ -n "$AGENT_VERSION" ] && tags="$tags,\"agent_version\":\"$AGENT_VERSION\""
    [ -n "$SOURCE" ] && tags="$tags,\"source\":\"$SOURCE\""
    curl --silent --fail --connect-timeout 3 --max-time 5 --retry 0 --request POST \
        --header 'Content-Type: application/json' \
        --data-raw "{\"message\":\"postman-plugin-install $1 $2${3:+ $3}${CAUSE:+ $CAUSE}\",\"level\":\"$level\",\"logger\":\"postman-plugin-install\",\"platform\":\"other\",\"fingerprint\":[\"postman-plugin-install\",\"$1\",\"$2\",\"$3\",\"$CAUSE\"],\"tags\":{$tags}}" \
        "$TELEMETRY_URL" >/dev/null 2>&1 || true
}

# Events are queued and sent after the result lines are printed, so a slow or blocked Sentry cannot delay them.
queue_report() {
    PENDING="$PENDING
$1|$2|$3|$CAUSE|$EXIT_CODE|$AGENT_VERSION"
}

flush_reports() {
    [ -n "$PENDING" ] || return 0
    queued=$PENDING
    PENDING=''
    printf '%s\n' "$queued" | while IFS='|' read -r r_agent r_outcome r_reason r_cause r_exit r_version; do
        [ -n "$r_agent" ] || continue
        CAUSE=$r_cause EXIT_CODE=$r_exit AGENT_VERSION=$r_version report "$r_agent" "$r_outcome" "$r_reason"
    done
}

# Maps a failed command's output to a fixed code, so a failure is diagnosable without sending the output.
classify() {
    text=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    case "$text" in
        *"no space left"*|*enospc*|*"not enough space"*) echo disk-full ;;
        *"could not resolve"*|*"name or service not known"*|*enotfound*|*getaddrinfo*|*"network is unreachable"*|*"temporary failure in name"*) echo network-dns ;;
        *"proxy authentication"*|*" 407"*|*"proxy error"*|*"tunnel connection failed"*) echo proxy ;;
        *certificate*|*"ssl "*|*"tls "*|*"unable to get local issuer"*) echo tls ;;
        *"timed out"*|*timeout*|*etimedout*) echo network-timeout ;;
        *"rate limit"*|*" 429"*|*"too many requests"*) echo rate-limited ;;
        *"terminal prompts disabled"*|*"could not read username"*|*"authentication failed"*|*"not logged in"*|*"please sign in"*|*"please log in"*) echo auth ;;
        *"permission denied"*|*eacces*|*"operation not permitted"*|*"read-only file system"*) echo permission ;;
        *"unknown option"*|*"unrecognized"*|*"unexpected argument"*|*"unknown command"*|*"no such command"*|*"invalid command"*) echo cli-unsupported ;;
        *"another process"*|*"already running"*|*"lock file"*|*"resource busy"*) echo busy ;;
        *) echo unknown ;;
    esac
}

# Runs a command and shows its output only when it fails. Leaves the exit code and a cause for the failure.
run() {
    out=$("$@" 2>&1) && return 0
    EXIT_CODE=$?
    CAUSE=$(classify "$out")
    printf '%s\n' "$out" >&2
    return 1
}

# The agent's own version string, kept to a safe character set.
agent_version() {
    "$1" --version 2>/dev/null | head -n 1 | clean 30
}

finish() {
    OUTCOME=$1
    REASON=${2:-}
}

has_id() {
    printf '%s' "$1" | grep -q "\"$2\"[[:space:]]*:[[:space:]]*\"$3\""
}

install_claude_code() {
    command -v claude >/dev/null 2>&1 || return 1
    DETECTED=1
    AGENT_VERSION=$(agent_version claude)

    plugins=$(claude plugin list --json 2>/dev/null) || { EXIT_CODE=$?; finish failed list-failed; return 0; }
    # postman@postman is the same plugin from our own marketplace; adding the official one would load it twice.
    if has_id "$plugins" id "$CLAUDE_PLUGIN" || has_id "$plugins" id 'postman@postman'; then
        finish already-installed
        return 0
    fi

    marketplaces=$(claude plugin marketplace list --json 2>/dev/null) || { EXIT_CODE=$?; finish failed list-failed; return 0; }
    if has_id "$marketplaces" name "$CLAUDE_MARKETPLACE"; then
        printf '%s' "$marketplaces" | grep -qi "$CLAUDE_REPO" || { finish failed marketplace-source-mismatch; return 0; }
        # A stale marketplace would install an old release. Refreshing it is best effort.
        run claude plugin marketplace update "$CLAUDE_MARKETPLACE" >/dev/null 2>&1 || true
        CAUSE=''
        EXIT_CODE=''
    else
        run claude plugin marketplace add "$CLAUDE_REPO" --scope user || { finish failed marketplace-add-failed; return 0; }
    fi

    run claude plugin install "$CLAUDE_PLUGIN" --scope user || { finish failed install-failed; return 0; }
    finish installed
}

install_codex() {
    command -v codex >/dev/null 2>&1 || return 1
    DETECTED=1
    AGENT_VERSION=$(agent_version codex)

    plugins=$(codex plugin list --json 2>/dev/null) || { EXIT_CODE=$?; finish failed list-failed; return 0; }
    if has_id "$plugins" pluginId "$CODEX_PLUGIN"; then
        finish already-installed
        return 0
    fi

    marketplaces=$(codex plugin marketplace list --json 2>/dev/null) || { EXIT_CODE=$?; finish failed list-failed; return 0; }
    if has_id "$marketplaces" name "$CODEX_MARKETPLACE"; then
        printf '%s' "$marketplaces" | grep -qi "$REPO" || { finish failed marketplace-source-mismatch; return 0; }
        run codex plugin marketplace upgrade "$CODEX_MARKETPLACE" --json >/dev/null 2>&1 || true
        CAUSE=''
        EXIT_CODE=''
    else
        run codex plugin marketplace add "$REPO" --json || { finish failed marketplace-add-failed; return 0; }
    fi

    run codex plugin add "$CODEX_PLUGIN" --json || { finish failed install-failed; return 0; }
    finish installed
}

# Cursor has no install command. Its editor loads any plugin folder under plugins/local.
install_cursor() {
    cursor_off_path="$HOME_DIR/.local/bin/cursor-agent"
    if ! command -v cursor >/dev/null 2>&1 && ! command -v cursor-agent >/dev/null 2>&1 &&
        [ ! -e "$cursor_off_path" ] && [ ! -d "$HOME_DIR/.cursor" ] &&
        { [ "$OS" != darwin ] || [ ! -d "$CURSOR_APP" ]; }; then
        return 1
    fi
    DETECTED=1

    clone="$HOME_DIR/.cursor/plugins/local/postman"
    if [ -f "$clone/.cursor-plugin/plugin.json" ] || [ -d "$HOME_DIR/.cursor/plugins/cache/cursor-public/postman" ]; then
        finish already-installed
        return 0
    fi
    [ ! -e "$clone" ] || { finish failed target-exists; return 0; }
    command -v git >/dev/null 2>&1 || { finish failed git-missing; return 0; }
    AGENT_VERSION=$(agent_version git)

    # Cloned beside the target and renamed, so a run that is killed halfway leaves nothing Cursor could load.
    # The partial folder is ours alone, so a leftover one is removed first.
    partial="$clone.partial"
    rm -rf "$partial"
    run git clone --depth 1 --branch "$BRANCH" "$GIT_URL" "$partial" || { rm -rf "$partial"; finish failed clone-failed; return 0; }
    mv "$partial" "$clone" 2>/dev/null || { rm -rf "$partial"; finish failed clone-failed; return 0; }
    finish installed
}

record() {
    agent=$1
    printf '  %s: %s%s\n' "$agent" "$OUTCOME" "${REASON:+ ($REASON)}"
    RESULTS="$RESULTS
result $agent $OUTCOME${REASON:+ $REASON}"
    queue_report "$agent" "$OUTCOME" "$REASON"
    [ "$OUTCOME" = failed ] && FAILED=1
}

# Runs on every exit. A run that did not finish is reported once, as an abort or a crash.
on_exit() {
    code=$?
    [ "$DONE" = 1 ] && return 0
    OUTCOME=failed
    CAUSE=''
    EXIT_CODE=$code
    AGENT_VERSION=''
    if [ "$ABORTED" = 1 ]; then reason=aborted; else reason=crashed; fi
    report "${CURRENT_AGENT:-script}" failed "$reason"
    [ "$ABORTED" = 1 ] || exit 4
}

trap on_exit EXIT
trap 'ABORTED=1; exit 130' INT TERM HUP

AGENTS=''
while [ $# -gt 0 ]; do
    case "$1" in
        --agent)
            [ $# -ge 2 ] || usage
            case "$2" in
                claude-code|codex|cursor) AGENTS="$AGENTS $2" ;;
                *) usage ;;
            esac
            shift 2
            ;;
        *) usage ;;
    esac
done
[ -n "$AGENTS" ] || AGENTS=' claude-code codex cursor'

if [ -z "$HOME_DIR" ]; then
    printf 'HOME is not set\n' >&2
    DONE=1
    exit 2
fi

for agent in $AGENTS; do
    OUTCOME=''
    REASON=''
    CAUSE=''
    EXIT_CODE=''
    AGENT_VERSION=''
    CURRENT_AGENT=$agent
    case "$agent" in
        claude-code) install_claude_code ;;
        codex) install_codex ;;
        cursor) install_cursor ;;
    esac || continue
    record "$agent"
done
CURRENT_AGENT=''

if [ "$DETECTED" = 0 ]; then
    printf 'No supported agent found. Install Claude Code, Codex or Cursor, or run npx @postman/postman-plugin.\n' >&2
    OUTCOME=skipped
    CAUSE=''
    EXIT_CODE=''
    AGENT_VERSION=''
    report none skipped no-agent
    DONE=1
    exit 3
fi

printf '%s\n' "$RESULTS" | sed '/^$/d'
flush_reports
DONE=1
[ "$FAILED" = 0 ] || exit 1
