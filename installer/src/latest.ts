import { type System, formatCommand } from './system.js';

export const PACKAGE = '@postman/postman-plugin';

type Version = { core: number[]; prerelease: boolean };

function parse (text: string): Version | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?/.exec(text.trim());

    return match ? { core: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null;
}

export function isNewer (candidate: string, current: string): boolean {
    const a = parse(candidate),
        b = parse(current);

    if (!a || !b) {
        return false;
    }

    const differs = a.core.findIndex((part, at) => part !== b.core[at]);

    return differs === -1 ? b.prerelease && !a.prerelease : a.core[differs] > b.core[differs];
}

/** Whether to ask the registry: only someone at a terminal reads the notice, and CI runs shouldn't wait on it. */
export function wantsReleaseCheck (env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
    return isTTY && !env.CI && !env.NO_UPDATE_NOTIFIER;
}

/**
 * Says when a newer release exists. A bare `npx` runs a global or project install of this package instead of
 * the registry's latest, so an older copy would otherwise keep running its own, older commands.
 */
export async function noteNewerRelease (system: System, current: string, args: string[]): Promise<void> {
    const exec = await system.probe('npm', ['view', `${PACKAGE}@latest`, 'version', '--fetch-retries=0', '--fetch-timeout=3000']),
        latest = exec.code === 0 ? exec.stdout.trim() : '';

    if (isNewer(latest, current)) {
        system.log(`note: this is ${PACKAGE} ${current}, and ${latest} is out. To use it, run \`${formatCommand('npx', [`${PACKAGE}@latest`, ...args])}\`.\n`);
    }
}
