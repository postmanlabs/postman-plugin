import type { System } from '../system.js';
import type { Host, HostId } from './types.js';

type Version = [number, number, number];

// An agent missing from this table is installed without a version check.
export const MINIMUM_VERSIONS: Partial<Record<HostId, { command: string; minimum: string }>> = {
    'claude-code': { command: 'claude', minimum: '2.1.268' },
    codex: { command: 'codex', minimum: '0.139.0' },
    opencode: { command: 'opencode', minimum: '1.18.32' },
    pi: { command: 'pi', minimum: '0.99.0' }
};

const VERSION_ARGS = ['--version'],
    SEMVER = /(\d+)\.(\d+)\.(\d+)/;

/** The first `x.y.z` in a CLI's `--version` output, which some prefix with a name or `v`. */
export function parseVersion (text: string): Version | null {
    const match = SEMVER.exec(text);

    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlder (version: Version, than: Version): boolean {
    const index = version.findIndex((part, i) => part !== than[i]);

    return index !== -1 && version[index] < than[index];
}

/** A warning when the agent reports a version below its minimum; `null` when it doesn't, or its version can't be read. */
export async function versionWarning (system: System, host: Host): Promise<string | null> {
    const policy = MINIMUM_VERSIONS[host.id];

    if (!policy) {
        return null;
    }

    try {
        const exec = await system.probe(policy.command, VERSION_ARGS),
            found = exec.code === 0 ? parseVersion(exec.stdout) : null,
            minimum = parseVersion(policy.minimum);

        if (!found || !minimum || !isOlder(found, minimum)) {
            return null;
        }

        return `${host.name} ${found.join('.')} is older than ${policy.minimum}, the oldest version Postman supports; ` +
            `update ${host.name} if the install fails or Postman doesn't load`;
    }
    catch {
        return null;
    }
}
