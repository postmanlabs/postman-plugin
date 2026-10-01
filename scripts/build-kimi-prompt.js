#!/usr/bin/env node
/**
 * Generates the session-start mandate Kimi loads through `systemPromptPath`.
 *
 * Kimi resolves a skill by its bare name, but the shared mandate names skills
 * `postman:<skill>` for the routes that namespace them. OpenCode and Pi rewrite
 * the names at runtime; Kimi runs no code, so the rewrite happens here.
 *
 * Run `node scripts/build-kimi-prompt.js` after editing the shared mandate. CI
 * runs it with `--check`, which also fails when Kimi would refuse the file:
 * Kimi only warns in its plugin diagnostics and drops the prompt.
 */
'use strict';

const fs = require('fs'),
    path = require('path');

const ROOT = path.join(__dirname, '..'),
    SOURCE = 'hooks/session-start-context.md',
    TARGET = '.kimi-plugin/session-start-context.md',
    MANIFEST = '.kimi-plugin/plugin.json',
    // PLUGIN_SYSTEM_PROMPT_MAX_BYTES in MoonshotAI/kimi-code packages/agent-core-v2/src/app/plugin/manifest.ts.
    MAX_BYTES = 32 * 1024;

/**
 * Same rewrite as toOpenCodeSessionContext and toPiSessionContext.
 *
 * @param {string} source - The shared mandate.
 * @returns {string} The mandate with bare skill names.
 */
function toKimiSessionContext (source) {
    return source.replace(/`postman:([a-z0-9-]+)`/g, '`$1`');
}

/**
 * @param {string} expected - What TARGET should contain.
 * @returns {string|null} Why the route would not deliver the mandate, or null.
 */
function problem (expected) {
    const declared = JSON.parse(read(MANIFEST)).systemPromptPath;

    if (declared !== `./${TARGET}`) {
        return `${MANIFEST}: systemPromptPath is ${JSON.stringify(declared)}, expected "./${TARGET}"`;
    }

    if (!fs.existsSync(path.join(ROOT, TARGET)) || read(TARGET) !== expected) {
        return `${TARGET} is stale. Run \`node scripts/build-kimi-prompt.js\` and commit the result.`;
    }

    const size = Buffer.byteLength(expected, 'utf8');

    if (size > MAX_BYTES) {
        return `${TARGET} is ${size} bytes, over Kimi's ${MAX_BYTES}-byte limit - Kimi ignores the file`;
    }

    if (!expected.trim()) {
        return `${TARGET} is empty - Kimi adds nothing to the system prompt`;
    }

    return null;
}

function read (rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const expected = toKimiSessionContext(read(SOURCE));

if (process.argv.includes('--check')) {
    const found = problem(expected);

    console.log(found ? `::error::${found}` : `ok ${TARGET}`);
    process.exitCode = found ? 1 : 0;
}
else {
    fs.writeFileSync(path.join(ROOT, TARGET), expected);
    console.log(`wrote ${TARGET}`);
}
