import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonc, withoutArrayString } from '../dist/hosts/opencode-config.js';

const SPEC = 'github:postmanlabs/postman-plugin';

test('parses comments, trailing commas and a byte order mark', () => {
    const text = `﻿// global config
{
    /* the model */ "model": "a/b", // inline
    "plugin": [
        "x", // keep
        "${SPEC}",
    ],
}
`;

    assert.deepEqual(parseJsonc(text), { model: 'a/b', plugin: ['x', SPEC] });
});

test('a line comment ends at a CR, in a file with CR-only line endings', () => {
    assert.deepEqual(parseJsonc(`{\r  // mine\r  "plugin": ["${SPEC}"]\r}\r`), { plugin: [SPEC] });
    assert.equal(withoutArrayString(`{\r  // mine\r  "plugin": ["x", "${SPEC}"]\r}\r`, 'plugin', SPEC), '{\r  // mine\r  "plugin": ["x"]\r}\r');
});

test('a // or /* inside a string is not a comment', () => {
    assert.deepEqual(parseJsonc('{"url": "https://example.com/a/*b*/", "plugin": ["x"]}'), { url: 'https://example.com/a/*b*/', plugin: ['x'] });
});

test('comments do not glue neighbouring tokens into a different value', () => {
    assert.equal(parseJsonc('{"n":1/*c*/e2}'), null);
    assert.equal(parseJsonc('{"a":tr/**/ue}'), null);
    assert.deepEqual(parseJsonc('{"n":1e2}'), { n: 100 });
});

test('a block comment that is never closed makes the file invalid, not shorter', () => {
    assert.equal(parseJsonc(`{"plugin":["${SPEC}"]} /*`), null);
    assert.equal(parseJsonc(`{"plugin":["${SPEC}"]} /* trailing`), null);
    assert.equal(withoutArrayString(`{"plugin":["${SPEC}"]} /*`, 'plugin', SPEC), null);
    assert.deepEqual(parseJsonc(`{"plugin":["${SPEC}"]} /* closed */`), { plugin: [SPEC] });
});

test('text that is not JSONC parses as null', () => {
    assert.equal(parseJsonc('{ "plugin": [ '), null);
    assert.equal(parseJsonc('not json'), null);
});

test('removes the first, a middle, the last and the only element, keeping layout', () => {
    const list = (...items) => `{\n    "plugin": [\n${items.map((item) => `        "${item}"`).join(',\n')}\n    ]\n}\n`,
        remove = (items) => withoutArrayString(list(...items), 'plugin', SPEC);

    assert.equal(remove([SPEC, 'b', 'c']), list('b', 'c'));
    assert.equal(remove(['a', SPEC, 'c']), list('a', 'c'));
    assert.equal(remove(['a', 'b', SPEC]), list('a', 'b'));
    assert.equal(remove([SPEC]), '{\n    "plugin": [\n        \n    ]\n}\n');
});

test('keeps comments and trailing commas that are not part of the removed element', () => {
    const text = `{
    // plugins I use
    "plugin": [
        "a", // first
        "${SPEC}", // ours
        "c", // last
    ], // done
    "model": "a/b"
}
`;

    assert.equal(withoutArrayString(text, 'plugin', SPEC), `{
    // plugins I use
    "plugin": [
        "a", // first
        // ours
        "c", // last
    ], // done
    "model": "a/b"
}
`);
});

test('removes from the array under the given key only, at the top level', () => {
    const text = `{ "plugins": ["${SPEC}"], "agent": { "plugin": ["${SPEC}"] }, "plugin": ["b"] }`;

    assert.equal(withoutArrayString(text, 'plugin', SPEC), null);
    assert.equal(withoutArrayString(text, 'plugins', SPEC), `{ "plugins": [], "agent": { "plugin": ["${SPEC}"] }, "plugin": ["b"] }`);
});

test('an element that is not in the array, or an array that is not there, is null', () => {
    assert.equal(withoutArrayString('{ "plugin": ["a"] }', 'plugin', SPEC), null);
    assert.equal(withoutArrayString('{ "model": "x" }', 'plugin', SPEC), null);
    assert.equal(withoutArrayString('{ "plugin": [["' + SPEC + '", {}]] }', 'plugin', SPEC), null);
});

test('removing the last element keeps a comment between it and the comma before it', () => {
    const text = `{\n  "plugin": [\n    "a", // keep\n    "${SPEC}"\n  ]\n}\n`,
        inline = `{ "plugin": ["a", /* keep */ "${SPEC}"] }`;

    assert.equal(withoutArrayString(text, 'plugin', SPEC), '{\n  "plugin": [\n    "a" // keep\n\n  ]\n}\n');
    assert.equal(withoutArrayString(inline, 'plugin', SPEC), '{ "plugin": ["a" /* keep */] }');
});
