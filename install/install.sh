#!/bin/sh
# Installs the Postman plugin into Claude Code, Codex and Cursor using each agent's own CLI.
# It needs no Node. `npx @postman/postman-plugin` covers every other agent.
#
#   curl -fsSL https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/install/install.sh | sh
#   sh install.sh --agent claude-code --agent codex
#
# An installed plugin is left alone, never updated. Exit codes: 0 done, 1 an agent failed,
# 2 bad usage, 3 no supported agent found. The last lines are `result <agent> <outcome> [reason]`.
#
# POSTMAN_PLUGIN_INSTALL_SOURCE tags the telemetry event (a-z, 0-9, _ and -, 40 characters).
# POSTMAN_PLUGIN_TELEMETRY=0 turns telemetry off. An event holds fixed codes only, never agent output.

set -u

REPO='postmanlabs/postman-plugin'
GIT_URL="https://github.com/$REPO.git"
BRANCH='main'
CLAUDE_MARKETPLACE='claude-plugins-official'
CLAUDE_REPO='anthropics/claude-plugins-official'
CLAUDE_PLUGIN="postman@$CLAUDE_MARKETPLACE"
CODEX_MARKETPLACE='postman'
CODEX_PLUGIN="postman@$CODEX_MARKETPLACE"
SCRIPT_VERSION='1'
# Overridable only so tests do not find a Cursor installed on the machine running them.
CURSOR_APP="${POSTMAN_PLUGIN_CURSOR_APP:-/Applications/Cursor.app}"
# Sentry store endpoint of the plugin installer project. Empty sends nothing.
TELEMETRY_URL="${POSTMAN_PLUGIN_TELEMETRY_URL:-}"

SOURCE=$(printf '%s' "${POSTMAN_PLUGIN_INSTALL_SOURCE:-}" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-40)
OS=$(uname -s 2>/dev/null | tr 'A-Z' 'a-z')
HOME_DIR="${HOME:-}"

OUTCOME=''
REASON=''
FAILED=0
DETECTED=0
RESULTS=''

usage() {
    printf 'Usage: install.sh [--agent claude-code|codex|cursor]...\n' >&2
    exit 2
}

# Fixed codes only: a Sentry event must never carry paths, agent output or user text.
report() {
    [ -n "$TELEMETRY_URL" ] || return 0
    [ "${POSTMAN_PLUGIN_TELEMETRY:-1}" = 0 ] && return 0
    command -v curl >/dev/null 2>&1 || return 0
    level=info
    [ "$2" = failed ] && level=error
    tags="\"agent\":\"$1\",\"outcome\":\"$2\",\"os\":\"$OS\",\"script_version\":\"$SCRIPT_VERSION\""
    [ -n "$3" ] && tags="$tags,\"reason\":\"$3\""
    [ -n "$SOURCE" ] && tags="$tags,\"source\":\"$SOURCE\""
    curl -fsS -m 5 -X POST -H 'Content-Type: application/json' \
        -d "{\"message\":\"postman-plugin-install $1 $2\",\"level\":\"$level\",\"logger\":\"postman-plugin-install\",\"platform\":\"other\",\"tags\":{$tags}}" \
        "$TELEMETRY_URL" >/dev/null 2>&1 || true
}

# Runs a command and shows its output only when it fails.
run() {
    out=$("$@" 2>&1) && return 0
    printf '%s\n' "$out" >&2
    return 1
}

finish() {
    OUTCOME=$1
    REASON=${2:-}
}

installed_claude() {
    printf '%s' "$1" | grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$2\""
}

install_claude_code() {
    command -v claude >/dev/null 2>&1 || return 1
    DETECTED=1

    plugins=$(claude plugin list --json 2>/dev/null) || { finish failed list-failed; return 0; }
    # postman@postman is the same plugin from our own marketplace; adding the official one would load it twice.
    if installed_claude "$plugins" "$CLAUDE_PLUGIN" || installed_claude "$plugins" 'postman@postman'; then
        finish already-installed
        return 0
    fi

    marketplaces=$(claude plugin marketplace list --json 2>/dev/null) || { finish failed list-failed; return 0; }
    if printf '%s' "$marketplaces" | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$CLAUDE_MARKETPLACE\""; then
        printf '%s' "$marketplaces" | grep -qi "$CLAUDE_REPO" || { finish failed marketplace-source-mismatch; return 0; }
        # A stale marketplace would install an old release. Refreshing it is best effort.
        run claude plugin marketplace update "$CLAUDE_MARKETPLACE" >/dev/null 2>&1 || true
    else
        run claude plugin marketplace add "$CLAUDE_REPO" --scope user || { finish failed marketplace-add-failed; return 0; }
    fi

    run claude plugin install "$CLAUDE_PLUGIN" --scope user || { finish failed install-failed; return 0; }
    finish installed
}

install_codex() {
    command -v codex >/dev/null 2>&1 || return 1
    DETECTED=1

    plugins=$(codex plugin list --json 2>/dev/null) || { finish failed list-failed; return 0; }
    if printf '%s' "$plugins" | grep -q "\"pluginId\"[[:space:]]*:[[:space:]]*\"$CODEX_PLUGIN\""; then
        finish already-installed
        return 0
    fi

    marketplaces=$(codex plugin marketplace list --json 2>/dev/null) || { finish failed list-failed; return 0; }
    if printf '%s' "$marketplaces" | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$CODEX_MARKETPLACE\""; then
        printf '%s' "$marketplaces" | grep -qi "$REPO" || { finish failed marketplace-source-mismatch; return 0; }
        run codex plugin marketplace upgrade "$CODEX_MARKETPLACE" --json >/dev/null 2>&1 || true
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

    run git clone --depth 1 --branch "$BRANCH" "$GIT_URL" "$clone" || { finish failed clone-failed; return 0; }
    finish installed
}

record() {
    agent=$1
    printf '  %s: %s%s\n' "$agent" "$OUTCOME" "${REASON:+ ($REASON)}"
    RESULTS="$RESULTS
result $agent $OUTCOME${REASON:+ $REASON}"
    report "$agent" "$OUTCOME" "$REASON"
    [ "$OUTCOME" = failed ] && FAILED=1
}

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
    exit 2
fi

for agent in $AGENTS; do
    OUTCOME=''
    REASON=''
    case "$agent" in
        claude-code) install_claude_code ;;
        codex) install_codex ;;
        cursor) install_cursor ;;
    esac || continue
    record "$agent"
done

if [ "$DETECTED" = 0 ]; then
    printf 'No supported agent found. Install Claude Code, Codex or Cursor, or run npx @postman/postman-plugin.\n' >&2
    exit 3
fi

printf '%s\n' "$RESULTS" | sed '/^$/d'
[ "$FAILED" = 0 ] || exit 1
