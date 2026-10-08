import assert from 'node:assert/strict';
import test from 'node:test';
import { isSameRepo, redact, redactText } from '../dist/source.js';

const REPO = 'postmanlabs/postman-plugin';

test('recognises this repo in every form git and the agent CLIs report it', () => {
    for (const source of [
        'postmanlabs/postman-plugin',
        'PostmanLabs/Postman-Plugin',
        'github.com/postmanlabs/postman-plugin',
        'https://github.com/postmanlabs/postman-plugin',
        'https://github.com/postmanlabs/postman-plugin.git',
        'https://github.com/postmanlabs/postman-plugin.git/',
        'https://github.com/postmanlabs/postman-plugin/',
        'https://x-access-token:ghp_secret@github.com/postmanlabs/postman-plugin.git',
        'git@github.com:postmanlabs/postman-plugin.git',
        'ssh://git@github.com/postmanlabs/postman-plugin.git',
        'git://github.com/postmanlabs/postman-plugin.git',
        'git+ssh://git@github.com/postmanlabs/postman-plugin.git',
        ' https://github.com/postmanlabs/postman-plugin.git\n'
    ]) {
        assert.ok(isSameRepo(source, REPO), source);
    }
});

test('rejects other repos, other hosts and local paths', () => {
    for (const source of [
        undefined,
        '',
        'someone/postman-plugin',
        'postmanlabs/postman-plugin-fork',
        'https://gitlab.com/postmanlabs/postman-plugin.git',
        'https://github.com.evil.example/postmanlabs/postman-plugin.git',
        'file://github.com/postmanlabs/postman-plugin',
        'ftp://github.com/postmanlabs/postman-plugin.git',
        '/src/postman-plugin'
    ]) {
        assert.equal(isSameRepo(source, REPO), false, String(source));
    }
});

test('redacts the user-info a token would sit in, and nothing else', () => {
    assert.equal(redact('https://x-access-token:ghp_secret@github.com/a/b.git'), 'https://github.com/a/b.git');
    assert.equal(redact('https://git:ghp_secret@github.com/a/b.git'), 'https://github.com/a/b.git');
    assert.equal(redact('ssh://git@github.com/a/b.git'), 'ssh://git@github.com/a/b.git');
    assert.equal(redact('ssh://ghp_secret@github.com/a/b.git'), 'ssh://github.com/a/b.git');
    assert.equal(redact('git@github.com:a/b.git'), 'git@github.com:a/b.git');
    assert.equal(redact('ghp_secret@github.com:someone/fork.git'), 'github.com:someone/fork.git');
    assert.equal(redact('/src/postman-plugin'), '/src/postman-plugin');
});

test('redacts the user-info of every URL in command output', () => {
    const output = 'error: failed to install git+https://someone:ghp_secret@github.com/a/b.git\nfrom https://x:tok@example.com/c and ssh://git@github.com/a/b.git';

    assert.equal(redactText(output), 'error: failed to install git+https://github.com/a/b.git\nfrom https://example.com/c and ssh://git@github.com/a/b.git');
});
