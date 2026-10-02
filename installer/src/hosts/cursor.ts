import path from 'node:path';
import type { System } from '../system.js';
import { guard, removeClone, syncClone } from './shared.js';
import { type Host, result } from './types.js';

// Cursor has no command to install a plugin, but its editor loads any plugin folder under
// plugins/local; its CLI doesn't. Its Marketplace keeps its own copy under plugins/cache.
const localClone = (system: System) => path.join(system.home, '.cursor', 'plugins', 'local', 'postman'),
    marketplaceCopy = (system: System) => path.join(system.home, '.cursor', 'plugins', 'cache', 'cursor-public', 'postman'),
    NEXT = 'Reload the Cursor window (Developer: Reload Window) for the change to take effect.',
    // Until https://github.com/postmanlabs/postman-plugin/issues/82 is fixed.
    cliNext = (system: System) => `The Cursor CLI doesn't load plugins from there; start it with \`cursor-agent --plugin-dir "${localClone(system)}"\`.`,
    // Cursor keeps a disabled Marketplace copy on disk and records "enabled" only in its
    // private state database, so the copy being there doesn't mean Postman is active.
    CHECK_ENABLED = 'If Postman isn\'t active in Cursor, enable it in Cursor Settings > Plugins.',
    MAYBE_TWICE = 'The Cursor Marketplace copy is present too; if it\'s enabled, Postman loads twice, so disable one in Cursor Settings > Plugins.';

export const cursor: Host = {
    id: 'cursor',
    name: 'Cursor',
    route: '.cursor-plugin',

    async detect (system) {
        // The Cursor CLI creates ~/.cursor only on its first run, and its installer can't put
        // ~/.local/bin on the PATH of the shell that ran it. It also installs `agent`, a name
        // too generic to mean Cursor.
        return (await system.which('cursor')) !== null || (await system.which('cursor-agent')) !== null ||
            await system.exists(path.join(system.home, '.local', 'bin', 'cursor-agent')) ||
            (system.platform === 'darwin' && await system.exists('/Applications/Cursor.app')) ||
            await system.exists(path.join(system.home, '.cursor'));
    },

    async status (system) {
        const fromMarketplace = await system.exists(marketplaceCopy(system)),
            cloned = await system.exists(localClone(system)),
            // The manifest Cursor reads; a directory without it is nothing Cursor can load.
            loadable = cloned && await system.exists(path.join(localClone(system), '.cursor-plugin', 'plugin.json')),
            notes = [
                ...(cloned && !loadable ? [`${localClone(system)} exists but has no .cursor-plugin/plugin.json, so Cursor loads nothing from it`] : []),
                ...(fromMarketplace && loadable ? ['the Cursor Marketplace copy is present too; if it\'s enabled, both load Postman'] : [])
            ];

        if (loadable) {
            return { installed: true, detail: `local clone at ${localClone(system)}`, notes };
        }

        return fromMarketplace ?
            { installed: true, detail: 'Cursor Marketplace copy present (enabled or not is up to Cursor)', notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            const fromMarketplace = await system.exists(marketplaceCopy(system));

            if (fromMarketplace && !(await system.exists(localClone(system)))) {
                return result('skipped', 'the Cursor Marketplace copy is present', CHECK_ENABLED);
            }

            // An existing clone is kept even next to the Marketplace copy, which may be
            // disabled: a duplicate is visible and fixable, deleting the working copy is not.
            const action = await syncClone(system, localClone(system));

            const next = `${NEXT} ${cliNext(system)}`;

            return result('done', `${action} ${localClone(system)}`, fromMarketplace ? `${next} ${MAYBE_TWICE}` : next);
        });
    },

    remove (system) {
        return guard(async () => {
            const cloned = await system.exists(localClone(system));

            if (cloned) {
                await removeClone(system, localClone(system));
            }

            if (await system.exists(marketplaceCopy(system))) {
                return result('manual', cloned ?
                    `removed ${localClone(system)}, but the Cursor Marketplace copy is still installed` :
                    'installed from the Cursor Marketplace', 'Uninstall it in Cursor Settings > Plugins.');
            }

            return cloned ? result('done', `removed ${localClone(system)}`, NEXT) : result('skipped', 'not installed');
        });
    }
};
