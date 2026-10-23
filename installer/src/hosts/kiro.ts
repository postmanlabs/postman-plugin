import path from 'node:path';
import { REPO } from '../source.js';
import { guard } from './shared.js';
import { type Host, result } from './types.js';

// Kiro imports a power only through its IDE's Powers panel; it has no command that does.
// `/tree/main/kiro` names the subfolder holding the power, which is not the repo root.
const POWER_URL = `https://github.com/${REPO}/tree/main/kiro`,
    STEPS = `In Kiro, open the Powers panel, choose Add Custom Power > Import power from GitHub, and enter ${POWER_URL}`;

export const kiro: Host = {
    id: 'kiro',
    name: 'Kiro',
    route: 'kiro',

    async detect (system) {
        return (await system.which('kiro')) !== null ||
            (system.platform === 'darwin' && await system.exists('/Applications/Kiro.app')) ||
            await system.exists(path.join(system.home, '.kiro'));
    },

    async status () {
        return { installed: null, detail: 'Kiro keeps its powers inside the IDE; check the Powers panel', notes: [] };
    },

    install () {
        return guard(async () => result('manual', 'Kiro imports powers only from its IDE', STEPS));
    },

    remove () {
        return guard(async () => result('manual', 'Kiro removes powers only from its IDE', 'In Kiro, open the Powers panel, select Postman and uninstall it.'));
    }
};
