#!/usr/bin/env bash
# Replaces postmanlabs/opencode-plugin's contents with a tree scripts/build-mirror.js built, then either
# commits it to main or tags it as a release:
#   push-mirror.sh <tree> main <source-sha>
#   push-mirror.sh <tree> tag <version>
# OPENCODE_PLUGIN_TOKEN is a fine-grained token with Contents read and write on that repository only.
set -euo pipefail

tree=$(cd "$1" && pwd)
mode=$2
arg=$3
: "${OPENCODE_PLUGIN_TOKEN:?set OPENCODE_PLUGIN_TOKEN to a token that can push to postmanlabs/opencode-plugin}"

# A directory with no git config: inside a checkout, actions/checkout's auth header would replace this token.
cd "$(mktemp -d)"
export GIT_TERMINAL_PROMPT=0
git clone --quiet --depth 1 "https://x-access-token:${OPENCODE_PLUGIN_TOKEN}@github.com/postmanlabs/opencode-plugin.git" mirror
cd mirror
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$tree"/. .
git add --all

case "$mode" in
    main)
        if git diff --cached --quiet; then
            echo "postmanlabs/opencode-plugin already matches $arg"
            exit 0
        fi
        git commit --quiet -m "sync: postmanlabs/postman-plugin@${arg:0:7}" -m "https://github.com/postmanlabs/postman-plugin/commit/$arg"
        git push --quiet origin HEAD:main
        ;;
    tag)
        tag="v$arg"
        if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
            echo "postmanlabs/opencode-plugin already has $tag"
            exit 0
        fi
        # main may have moved on since the release commit; the tag then points at a commit of its own, off main.
        if ! git diff --cached --quiet; then
            git commit --quiet -m "release: @postman/opencode-plugin@$arg"
        fi
        git tag -a "$tag" -m "@postman/opencode-plugin@$arg"
        git push --quiet origin "refs/tags/$tag"
        ;;
    *)
        echo "usage: push-mirror.sh <tree> main <source-sha> | push-mirror.sh <tree> tag <version>" >&2
        exit 2
        ;;
esac
