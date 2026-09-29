import path from 'node:path';
import { OPENCODE_SHIM } from '../source.js';
import type { System } from '../system.js';
import { blocked, guard, removeClone, syncClone } from './shared.js';
import { type Host, result } from './types.js';

// The install opencode/README.md documents: a clone of this repo next to a
// one-line plugin file that re-exports opencode/src/index.ts from it.
const configDir = (system: System) => path.join(system.env.XDG_CONFIG_HOME || path.join(system.home, '.config'), 'opencode'),
    cloneDir = (system: System) => path.join(configDir(system), 'postman-plugin'),
    shimFile = (system: System) => path.join(configDir(system), 'plugins', 'postman.ts'),
    NEXT = 'Restart OpenCode for the change to take effect.';

export const opencode: Host = {
    id: 'opencode',
    name: 'OpenCode',
    route: 'opencode/package.json',

    async detect (system) {
        return (await system.which('opencode')) !== null;
    },

    async status (system) {
        const cloned = await system.exists(cloneDir(system)),
            shim = await system.readFile(shimFile(system));

        if (cloned && shim === OPENCODE_SHIM) {
            return { installed: true, detail: `clone at ${cloneDir(system)}`, notes: [] };
        }

        const notes = [
            ...(shim !== null && shim !== OPENCODE_SHIM ? [`${shimFile(system)} has other contents; install will refuse to overwrite it`] : []),
            ...(cloned && shim === null ? [`${cloneDir(system)} exists but nothing loads it`] : [])
        ];

        return { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            const shim = await system.readFile(shimFile(system));

            if (shim !== null && shim !== OPENCODE_SHIM) {
                blocked(`${shimFile(system)} exists with other contents; move it aside and re-run`);
            }

            const action = await syncClone(system, cloneDir(system));

            if (shim === null) {
                await system.writeFile(shimFile(system), OPENCODE_SHIM);
            }

            return result('done', `${action} ${cloneDir(system)}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const cloned = await system.exists(cloneDir(system)),
                shim = await system.readFile(shimFile(system));

            if (!cloned && shim !== OPENCODE_SHIM) {
                return result('skipped', 'not installed');
            }

            const removed = cloned ? [cloneDir(system)] : [];

            // The clone is checked before anything is deleted, so a refusal leaves both in place.
            await removeClone(system, cloneDir(system));

            if (shim === OPENCODE_SHIM) {
                await system.remove(shimFile(system));
                removed.push(shimFile(system));
            }

            return result('done', `removed ${removed.join(' and ')}`, NEXT);
        });
    }
};
