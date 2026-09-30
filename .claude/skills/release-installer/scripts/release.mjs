#!/usr/bin/env node
// The deterministic half of the release-installer skill; SKILL.md says when to run each command.
// `check` and `verify` exit 1 when anything they check fails.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NAME = '@postman/postman-plugin',
    GALLERY = `https://pi.dev/packages/${NAME}`,
    // release.yml's own tag pattern and dist-tag allowlist, so a version passing here passes there.
    VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-([A-Za-z0-9-]+)[A-Za-z0-9.-]*)?$/,
    SEMVER = 'semver@7.8.5',
    // Everything the tarball ships or builds from; a change elsewhere reaches no user.
    SHIPPED = ['installer', 'skills', 'hooks/session-start-context.md', 'mcp.pi.json', 'README.md', 'LICENSE'],
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function sh (command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });

    return { code: result.status ?? 1, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

const tagOf = (version) => `${NAME}@${version}`;

function distTagOf (version) {
    const match = version.match(VERSION_PATTERN);

    if (!match) {
        return null;
    }

    const prerelease = match[2];

    if (!prerelease) {
        return 'latest';
    }

    if (/^(rc|next|[0-9]+)$/.test(prerelease)) {
        return 'next';
    }

    return /^(alpha|beta|canary)$/.test(prerelease) ? prerelease : null;
}

function distTags () {
    const { code, out } = sh('npm', ['view', NAME, 'dist-tags', '--json']);

    return code === 0 && out ? JSON.parse(out) : {};
}

function parse (version) {
    const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);

    return match ? { major: +match[1], minor: +match[2], patch: +match[3], rc: match[4] === undefined ? null : +match[4] } : null;
}

const base = ({ major, minor, patch }) => `${major}.${minor}.${patch}`;

function increment (version, level) {
    const { major, minor, patch } = parse(version);

    return { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[level];
}

/** True when `version` is newer than `than`, by the same semver release.yml runs. */
function newer (version, than) {
    return sh('npx', ['-y', SEMVER, '--include-prerelease', '--range', `>${than}`, version]).code === 0;
}

function status () {
    sh('git', ['fetch', '--quiet', '--tags', 'origin']);

    const tags = distTags(),
        releaseTags = sh('git', ['tag', '--list', `${NAME}@*`, '--sort=-creatordate']).out.split('\n').filter(Boolean),
        lastLatest = releaseTags.find((tag) => distTagOf(tag.slice(NAME.length + 1)) === 'latest'),
        range = lastLatest ? `${lastLatest}..origin/main` : 'origin/main',
        changes = sh('git', ['log', '--oneline', '--no-merges', range, '--', ...SHIPPED]).out;

    console.log(`npm dist-tags: ${JSON.stringify(tags)}`);
    console.log(`release tags, newest first: ${releaseTags.slice(0, 5).join(', ') || 'none'}`);
    console.log(`changes to shipped files on origin/main since ${lastLatest || 'the start'}:`);
    console.log(changes ? changes.replace(/^/gm, '  ') : '  none');
}

function suggest (kind, level) {
    const { latest, next } = distTags(),
        current = parse(latest),
        line = parse(next),
        // An open rc line is one whose base is newer than latest; it continues until promoted.
        openLine = line && line.rc !== null && current && newer(base(line), latest) ? line : null;

    if (!current || (level && !['patch', 'minor', 'major'].includes(level)) || !['rc', 'latest'].includes(kind)) {
        throw new Error('usage: suggest <rc|latest> [patch|minor|major], with a plain version on latest');
    }

    if (kind === 'rc') {
        console.log(openLine && !level ? `${base(openLine)}-rc.${openLine.rc + 1}` : `${increment(latest, level || 'patch')}-rc.0`);
    }
    else {
        console.log(openLine && !level ? base(openLine) : increment(latest, level || 'patch'));
    }
}

function check (version) {
    const problems = [],
        distTag = distTagOf(version),
        tag = tagOf(version);

    if (!distTag) {
        problems.push(`${version} is not <major>.<minor>.<patch>[-rc.N|-alpha.N|-beta.N|-canary.N]`);
    }
    else {
        if (sh('npm', ['view', `${NAME}@${version}`, 'version']).out) {
            problems.push(`${NAME}@${version} is already on npm; versions are immutable`);
        }

        const current = distTags()[distTag];

        if (current && !newer(version, current)) {
            problems.push(`${version} would move the '${distTag}' dist-tag back from ${current}`);
        }
    }

    if (sh('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).out) {
        problems.push(`${tag} is already on origin; never move a pushed tag, cut the next version`);
    }

    if (sh('gh', ['auth', 'status']).code !== 0) {
        problems.push('gh is not signed in; run `gh auth login`');
    }

    console.log(`tag: ${tag}\ndist-tag: ${distTag || 'none'}`);
    report(problems);
}

function bump (version) {
    if (!distTagOf(version)) {
        throw new Error(`${version} is not a version release.yml accepts`);
    }

    execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: path.join(root, 'installer'), stdio: 'ignore' });

    const file = path.join(root, 'mcp.pi.json'),
        config = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const server of Object.values(config.mcpServers)) {
        server.headers['X-Plugin-Version'] = version;
        server.headers['User-Agent'] = `${server.headers['X-Source']}/${version}`;
    }

    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(sh('git', ['status', '--short']).out);
}

function verify (version) {
    const problems = [],
        distTag = distTagOf(version),
        tag = tagOf(version),
        release = sh('gh', ['release', 'view', tag, '--json', 'isPrerelease,url']),
        ran = sh('npx', ['-y', `${NAME}@${version}`, '--version']).out;

    if (sh('npm', ['view', `${NAME}@${version}`, 'version']).out !== version) {
        problems.push(`${NAME}@${version} is not on npm`);
    }

    if (distTags()[distTag] !== version) {
        problems.push(`the '${distTag}' dist-tag does not point at ${version}`);
    }

    if (release.code !== 0) {
        problems.push(`${tag} has no GitHub release page; rerun: gh workflow run release.yml -f tag=${tag}`);
    }
    else if (JSON.parse(release.out).isPrerelease !== (distTag !== 'latest')) {
        problems.push(`${tag}'s release page has the wrong pre-release flag`);
    }

    if (ran !== version) {
        problems.push(`npx ${NAME}@${version} --version printed "${ran}"`);
    }

    if (distTag === 'latest') {
        const listed = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '15', GALLERY]).out;

        console.log(listed === '200' ?
            `Pi gallery: ${GALLERY}` :
            `Pi gallery: not listed yet (HTTP ${listed}); it indexes npm on its own schedule, so check again later`);
    }

    report(problems);
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    elapsed = (start) => `${Math.round((Date.now() - start) / 1000)}s`;

/** Polls `probe` every `seconds` until it returns a value, or returns null at `deadline`. */
async function until (deadline, seconds, probe) {
    for (;;) {
        const value = probe();

        if (value) {
            return value;
        }

        if (Date.now() + seconds * 1000 > deadline) {
            return null;
        }

        await sleep(seconds);
    }
}

function runFor (tag) {
    const { out } = sh('gh', ['run', 'list', '--workflow', 'release.yml', '--branch', tag, '--limit', '1', '--json', 'databaseId,status,conclusion,url']),
        runs = out ? JSON.parse(out) : [];

    return runs[0] ?? null;
}

function failedSteps (id) {
    const { out } = sh('gh', ['run', 'view', String(id), '--json', 'jobs', '--jq',
        '[.jobs[] | select(.conclusion == "failure") | "\\(.name): \\([.steps[] | select(.conclusion == "failure") | .name] | join(", "))"] | join("; ")']);

    return out || `no failed step reported; read \`gh run view ${id} --log-failed\``;
}

/** Follows the tag's release.yml run, then waits until npm serves the version and npx can run it. */
async function watch (version, minutes = '30') {
    const tag = tagOf(version),
        distTag = distTagOf(version),
        start = Date.now(),
        deadline = start + Number(minutes) * 60 * 1000,
        timedOut = (what) => report([`timed out after ${minutes} minutes waiting for ${what}`]);

    if (!distTag || !(Number(minutes) > 0)) {
        throw new Error('usage: watch <version> [minutes]');
    }

    let run = await until(deadline, 10, () => runFor(tag));

    if (!run) {
        return timedOut(`a release.yml run for ${tag}; was the tag pushed?`);
    }

    console.log(`run ${run.databaseId}: ${run.url}`);

    let seen = '';

    run = await until(deadline, 15, () => {
        const current = runFor(tag);

        if (current && current.status !== seen) {
            seen = current.status;
            console.log(`run ${current.databaseId} ${current.status} (${elapsed(start)})`);
        }

        return current?.status === 'completed' ? current : null;
    });

    if (!run) {
        return timedOut(`run ${seen ? 'to finish' : 'to start'}`);
    }

    if (run.conclusion !== 'success') {
        return report([`run ${run.databaseId} ended ${run.conclusion}: ${failedSteps(run.databaseId)}`]);
    }

    // The registry, the dist-tag and the tarball CDN each lag on their own.
    const live = await until(deadline, 15, () => {
        const served = sh('npm', ['view', `${NAME}@${version}`, 'version', '--prefer-online']).out === version,
            tagged = served && JSON.parse(sh('npm', ['view', NAME, 'dist-tags', '--json', '--prefer-online']).out || '{}')[distTag] === version,
            ran = tagged && sh('npx', ['-y', '--prefer-online', `${NAME}@${version}`, '--version']).out === version;

        return ran;
    });

    if (!live) {
        return timedOut(`npm to serve ${NAME}@${version} on '${distTag}'`);
    }

    console.log(`live: ${NAME}@${version} on '${distTag}', ${elapsed(start)} after the watch began`);
    report([]);
}

function report (problems) {
    for (const problem of problems) {
        console.log(`FAIL ${problem}`);
    }

    console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
    process.exitCode = problems.length ? 1 : 0;
}

const [command, ...args] = process.argv.slice(2),
    commands = { status, suggest, check, bump, watch, verify };

if (!commands[command] || (command !== 'status' && !args[0])) {
    console.error('usage: release.mjs status | suggest <rc|latest> [patch|minor|major] | check <version> | bump <version> | watch <version> [minutes] | verify <version>');
    process.exit(2);
}

try {
    await commands[command](...args);
}
catch (error) {
    console.error(error.message);
    process.exit(2);
}
