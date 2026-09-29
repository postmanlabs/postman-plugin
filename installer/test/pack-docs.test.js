import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toPackageReadme } from '../scripts/pack-docs.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    BLOB = 'https://github.com/postmanlabs/postman-plugin/blob/main/',
    RAW = 'https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/';

test('relative links point at the repo on GitHub; images at their raw files', () => {
    assert.equal(toPackageReadme('[guide](CONTRIBUTING.md#layout)'), `[guide](${BLOB}CONTRIBUTING.md#layout)`);
    assert.equal(toPackageReadme('[skills](./skills/)'), `[skills](${BLOB}skills/)`);
    assert.equal(toPackageReadme('![logo](assets/logo.png)'), `![logo](${RAW}assets/logo.png)`);
    assert.equal(toPackageReadme('<a href="LICENSE"><img src="assets/a.png"></a>'), `<a href="${BLOB}LICENSE"><img src="${RAW}assets/a.png"></a>`);
});

test('absolute URLs, anchors and root-relative paths are left alone', () => {
    const untouched = '[a](https://postman.com) [b](#install) [c](mailto:x@y.z) [d](/docs) <img src="https://x/y.png">';

    assert.equal(toPackageReadme(untouched), untouched);
});

test('no relative link survives in the README npm would publish', () => {
    const published = toPackageReadme(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')),
        relative = [...published.matchAll(/\]\((?![a-z][a-z0-9+.-]*:|#)([^)]+)\)|(?:src|href)="(?![a-z][a-z0-9+.-]*:|#)([^"]+)"/gi)]
            .map((match) => match[1] ?? match[2]);

    assert.deepEqual(relative, []);
});
