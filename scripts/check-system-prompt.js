#!/usr/bin/env node
/**
 * Fails unless the Kimi manifest's `systemPromptPath` is a file Kimi will load.
 * Kimi only warns in its plugin diagnostics and drops the prompt, so the route
 * would ship without the session-start mandate and nothing else would notice.
 *
 * Mirrors readSystemPrompt() in MoonshotAI/kimi-code
 * packages/agent-core-v2/src/app/plugin/manifest.ts. Pass a manifest path to
 * check another file.
 */
'use strict';

const fs = require('fs'),
    path = require('path');

const ROOT = path.join(__dirname, '..'),
    MANIFEST = process.argv[2] || '.kimi-plugin/plugin.json',
    // PLUGIN_SYSTEM_PROMPT_MAX_BYTES in Kimi's manifest.ts.
    MAX_BYTES = 32 * 1024;

/**
 * @param {string} manifestRel - Manifest path relative to the repo root.
 * @returns {string|null} Why Kimi would not load the prompt, or null if it would.
 */
function problem (manifestRel) {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, manifestRel), 'utf8')),
        value = manifest.systemPromptPath;

    if (value === undefined) {
        return 'no `systemPromptPath` - the route ships without the session-start mandate';
    }

    if (typeof value !== 'string' || !value.trim()) {
        return '`systemPromptPath` must be a non-blank string';
    }

    const declared = value.trim();

    if (!declared.startsWith('./')) {
        return `\`systemPromptPath\` must start with "./" (got "${declared}")`;
    }

    const rootReal = fs.realpathSync(ROOT),
        absolute = path.resolve(ROOT, declared),
        real = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute,
        relative = path.relative(rootReal, real);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return `\`systemPromptPath\` resolves outside the plugin root (${declared})`;
    }

    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) {
        return `\`systemPromptPath\` is not a file (${declared})`;
    }

    const { size } = fs.statSync(real);

    if (size > MAX_BYTES) {
        return `${declared} is ${size} bytes, over Kimi's ${MAX_BYTES}-byte limit - Kimi ignores the file`;
    }

    if (!fs.readFileSync(real, 'utf8').replace(/^\uFEFF/, '').trim()) {
        return `${declared} is empty - Kimi adds nothing to the system prompt`;
    }

    return null;
}

const found = problem(MANIFEST);

console.log(found ? `::error file=${MANIFEST}::${found}` : `ok ${MANIFEST}`);
process.exitCode = found ? 1 : 0;
