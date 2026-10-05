import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createSystem } from '../dist/system.js';

const system = createSystem({ log: () => {} }),
    windows = process.platform === 'win32',
    // Root reads through any mode bits; a Windows deny ACE binds its admins too.
    permissionsApply = windows || process.getuid?.() !== 0,
    // libuv reports Windows' ERROR_ACCESS_DENIED as EPERM where POSIX says EACCES.
    DENIED = windows ? 'EPERM' : 'EACCES',
    me = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;

function icacls (...args) {
    const result = spawnSync('icacls', args, { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stdout + result.stderr);
}

function lock (target, { directory = false } = {}) {
    if (windows) {
        icacls(target, '/deny', `${me}:${directory ? '(OI)(CI)(F)' : '(R)'}`);
    }
    else {
        fs.chmodSync(target, directory ? 0o000 : 0o200);
    }
}

function unlock (target) {
    if (windows) {
        icacls(target, '/remove:d', me);
    }
    else {
        fs.chmodSync(target, 0o700);
    }
}

test('output split in the middle of a UTF-8 character still decodes', async () => {
    // Writes the two bytes of "é" separately, so they arrive as two chunks.
    const script = 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50);',
        { code, stdout } = await system.probe(process.execPath, ['-e', script]);

    assert.equal(code, 0);
    assert.equal(stdout, 'é');
});

test('a command that reads stdin gets EOF instead of waiting for input', { timeout: 10000 }, async () => {
    const script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));",
        { code, stdout } = await system.probe(process.execPath, ['-e', script]);

    assert.equal(code, 0);
    assert.equal(stdout, 'eof');
});

test('readFile is null only for a file that does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-'));

    fs.writeFileSync(path.join(dir, 'a-file'), '');

    assert.equal(await system.readFile(path.join(dir, 'missing.ts')), null);
    assert.equal(await system.readFile(path.join(dir, 'a-file', 'below-it.ts')), null);
    await assert.rejects(system.readFile(dir));
});

test('exists is false only for a path that does not exist', { skip: !permissionsApply && 'needs a non-root user' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-')),
        locked = path.join(dir, 'locked'),
        // Windows skips traverse checks, so only a path that exists under the lock is refused.
        refused = path.join(locked, windows ? 'present' : 'inside');

    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'present'), '');
    fs.writeFileSync(path.join(dir, 'a-file'), '');
    lock(locked, { directory: true });

    try {
        assert.equal(await system.exists(path.join(dir, 'missing')), false);
        assert.equal(await system.exists(path.join(dir, 'a-file', 'below-it')), false);
        await assert.rejects(system.exists(refused), { code: DENIED });
    }
    finally {
        unlock(locked);
    }
});

test('readFile throws for a file that exists but cannot be read', { skip: !permissionsApply && 'needs a non-root user' }, async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-')), 'write-only.ts');

    fs.writeFileSync(file, 'export default {};\n');
    lock(file);

    try {
        await assert.rejects(system.readFile(file), { code: DENIED });
    }
    finally {
        unlock(file);
    }
});

test('an npm-style .cmd shim on PATH runs through cmd.exe with its arguments intact', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    // A space in the directory exercises quoting of the shim's own path, as under "Program Files".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman plugin cmd-')),
        previous = process.env.PATH;

    fs.writeFileSync(path.join(dir, 'fakecli.cmd'), '@echo off\r\necho [%1] [%2] [%3]\r\nexit /b 3\r\n');
    process.env.PATH = `${dir}${path.delimiter}${previous}`;

    try {
        const windows = createSystem({ log: () => {} }),
            probed = await windows.probe('fakecli', ['plugin', 'two words', 'x@y']),
            ran = await windows.run('fakecli', ['list'], { env: { DO_NOT_TRACK: '1' } });

        assert.match(await windows.which('fakecli'), /fakecli\.cmd$/i);
        assert.equal(probed.code, 3);
        assert.equal(probed.stdout.trim(), '[plugin] ["two words"] [x@y]');
        assert.equal(ran.code, 3);
        assert.equal(ran.stdout.trim(), '[list] [] []');
    }
    finally {
        process.env.PATH = previous;
    }
});

test('readDir lists a directory, and is empty for a path that is missing or not a directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-'));

    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a-file'), '');

    assert.deepEqual((await system.readDir(dir)).sort(), ['a-file', 'sub']);
    assert.deepEqual(await system.readDir(path.join(dir, 'missing')), []);
    assert.deepEqual(await system.readDir(path.join(dir, 'a-file', 'below-it')), []);
    assert.deepEqual(await system.readDir(path.join(dir, 'a-file')), []);
});
