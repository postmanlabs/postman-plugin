import path from 'node:path';
import type { System } from '../system.js';
import { guard, removeClone, syncClone } from './shared.js';
import { type Host, result } from './types.js';

// Cursor has no command to install a plugin, but loads any plugin folder under
// plugins/local. Its Marketplace keeps its own copy under plugins/cache.
const localClone = (system: System) => path.join(system.home, '.cursor', 'plugins', 'local', 'postman'),
    marketplaceCopy = (system: System) => path.join(system.home, '.cursor', 'plugins', 'cache', 'cursor-public', 'postman'),
    NEXT = 'Reload the Cursor window (Developer: Reload Window) for the change to take effect.';

export const cursor: Host = {
    id: 'cursor',
    name: 'Cursor',
    route: '.cursor-plugin',

    async detect (system) {
        return (await system.which('cursor')) !== null ||
            (system.platform === 'darwin' && await system.exists('/Applications/Cursor.app')) ||
            await system.exists(path.join(system.home, '.cursor'));
    },

    async status (system) {
        const fromMarketplace = await system.exists(marketplaceCopy(system)),
            cloned = await system.exists(localClone(system)),
            notes = fromMarketplace && cloned ? [`the Cursor Marketplace copy and ${localClone(system)} both load it`] : [];

        if (cloned) {
            return { installed: true, detail: `local clone at ${localClone(system)}`, notes };
        }

        return fromMarketplace ?
            { installed: true, detail: 'installed from the Cursor Marketplace', notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            if (!(await system.exists(localClone(system))) && await system.exists(marketplaceCopy(system))) {
                return result('skipped', 'already installed from the Cursor Marketplace');
            }

            const action = await syncClone(system, localClone(system));

            return result('done', `${action} ${localClone(system)}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            if (await system.exists(localClone(system))) {
                await removeClone(system, localClone(system));

                return result('done', `removed ${localClone(system)}`, NEXT);
            }

            return await system.exists(marketplaceCopy(system)) ?
                result('manual', 'installed from the Cursor Marketplace', 'Uninstall it in Cursor Settings > Plugins.') :
                result('skipped', 'not installed');
        });
    }
};
