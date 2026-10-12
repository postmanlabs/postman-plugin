import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The scripts and the TypeScript adapters install the same plugin from the same places. Nothing else
// ties their constants together, so a change to one that misses the others installs from the wrong place.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8'),
    sh = read('install', 'install.sh'),
    ps1 = read('install', 'install.ps1'),
    source = read('installer', 'src', 'source.ts'),
    claude = read('installer', 'src', 'hosts', 'claude-code.ts'),
    codex = read('installer', 'src', 'hosts', 'codex.ts'),
    cursor = read('installer', 'src', 'hosts', 'cursor.ts'),
    shared = read('installer', 'src', 'hosts', 'shared.ts'),
    // The first quoted value after `name =` or `name:` in a TypeScript source.
    ts = (text, name) => text.match(new RegExp(`${name}\\s*[=:]\\s*'([^']+)'`))?.[1],
    shVar = (name) => sh.match(new RegExp(`^${name}='([^']+)'`, 'm'))?.[1],
    psVar = (name) => ps1.match(new RegExp(`\\$${name} = '([^']+)'`))?.[1];

test('both scripts name the repo and branch the installer clones', () => {
    assert.equal(shVar('REPO'), ts(source, 'REPO'));
    assert.equal(shVar('BRANCH'), ts(source, 'BRANCH'));
    assert.equal(psVar('Repo'), ts(source, 'REPO'));
    assert.equal(psVar('Branch'), ts(source, 'BRANCH'));
    assert.ok(source.includes('https://github.com/${REPO}.git'), 'the clone URL is still built from REPO');
});

test('Claude Code: marketplace name, repo and plugin id match the adapter', () => {
    const name = ts(claude, 'name'),
        repo = ts(claude, 'repo');

    assert.equal(shVar('CLAUDE_MARKETPLACE'), name);
    assert.equal(shVar('CLAUDE_REPO'), repo);
    assert.equal(psVar('ClaudeMarketplace'), name);
    assert.equal(psVar('ClaudeRepo'), repo);
    assert.ok(claude.includes('PLUGIN_ID = `postman@${MARKETPLACE.name}`'), 'the plugin id is still postman@<marketplace>');
    assert.match(sh, /CLAUDE_PLUGIN="postman@\$CLAUDE_MARKETPLACE"/);
    assert.match(ps1, /\$ClaudePlugin = "postman@\$ClaudeMarketplace"/);
    assert.match(claude, /SCOPE = 'user'/);
    assert.match(sh, /--scope user/);
    assert.match(ps1, /'--scope', 'user'/);
});

test('Codex: marketplace name and plugin id match the adapter', () => {
    const marketplace = ts(codex, 'MARKETPLACE');

    assert.equal(shVar('CODEX_MARKETPLACE'), marketplace);
    assert.equal(psVar('CodexMarketplace'), marketplace);
    assert.ok(codex.includes('PLUGIN_ID = `postman@${MARKETPLACE}`'), 'the plugin id is still postman@<marketplace>');
    assert.match(sh, /CODEX_PLUGIN="postman@\$CODEX_MARKETPLACE"/);
    assert.match(ps1, /\$CodexPlugin = "postman@\$CodexMarketplace"/);
});

test('Cursor: both scripts use the folders the adapter does', () => {
    assert.match(cursor, /'\.cursor', 'plugins', 'local', 'postman'/);
    assert.match(cursor, /'\.cursor', 'plugins', 'cache', 'cursor-public', 'postman'/);
    assert.match(sh, /\.cursor\/plugins\/local\/postman/);
    assert.match(sh, /\.cursor\/plugins\/cache\/cursor-public\/postman/);
    assert.match(ps1, /plugins\\local\\postman/);
    assert.match(ps1, /plugins\\cache\\cursor-public\\postman/);
    assert.match(cursor, /\.cursor-plugin', 'plugin\.json'/);
    assert.ok(sh.includes('.cursor-plugin/plugin.json') && ps1.includes('.cursor-plugin\\plugin.json'));
    assert.match(shared, /'clone', '--depth', '1', '--branch', BRANCH, GIT_URL/);
});

test('the two scripts report the same reason codes', () => {
    const reasons = (text) => new Set([...text.matchAll(/(?:finish failed|Finish 'failed') '?([a-z-]+)/g)].map((match) => match[1]));

    assert.deepEqual([...reasons(sh)].sort(), [...reasons(ps1)].sort());
});

test('both scripts report to the same Sentry endpoint by default', () => {
    const endpoint = /https:\/\/[a-z0-9.]+\.ingest\.[a-z.]*sentry\.io\/api\/\d+\/store\/\?sentry_key=[0-9a-f]{32}/;

    assert.ok(sh.match(endpoint));
    assert.equal(sh.match(endpoint)?.[0], ps1.match(endpoint)?.[0]);
});
