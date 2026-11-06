import path from 'node:path';
import type { JsonRpc } from '../json-rpc.js';
import type { System } from '../system.js';

// The Codex route no longer declares this hook, but installs from 0.4.1 to 0.7.1 wrote its approval.
export const POSTMAN_HOOK_KEY = 'postman@postman:hooks/codex-hooks.json:session_start:0:0';

type UserLayer = { name: { type: string; file?: string }; version: string; config?: { hooks?: { state?: Record<string, unknown> } } };

// A quoted segment, since the key itself holds dots. `replace` with null deletes the table and nothing beside it;
// when ours is the only approval, `hooks.state` goes too, or the empty header older installs wrote would stay behind.
const revokeEdit = (layer: Pick<UserLayer, 'version'> & { file?: string }, onlyEntry = false) => ({
    edits: [{ keyPath: onlyEntry ? 'hooks.state' : `hooks.state.${JSON.stringify(POSTMAN_HOOK_KEY)}`, value: null, mergeStrategy: 'replace' }],
    expectedVersion: layer.version,
    ...(layer.file ? { filePath: layer.file } : {}),
    reloadUserConfig: true
});

class Uncheckable extends Error {}

async function userLayer (rpc: JsonRpc): Promise<UserLayer | undefined> {
    const read = await rpc.request<{ layers?: UserLayer[] | null }>('config/read', { includeLayers: true });

    // A Codex without layered reads can't say where the approval is; no user layer means no user config at all.
    if (!Array.isArray(read?.layers)) {
        throw new Uncheckable('config/read returned no config layers');
    }

    return read.layers.find((layer) => layer.name?.type === 'user');
}

/** `unchecked` when this run could not tell whether the approval is there: a dry run, or a Codex that can't say. */
export type Revocation = 'removed' | 'absent' | 'kept' | 'unchecked';

/** Deletes the session-start hook approval older installs wrote. Never fails the remove. */
export async function revokePostmanHookApproval (system: System): Promise<Revocation> {
    const note = (message: string) => system.log(`  note: ${message}`),
        configFile = path.join(system.env.CODEX_HOME || path.join(system.home, '.codex'), 'config.toml');

    if (system.dryRun) {
        note('Would delete Postman\'s session-start hook approval from the Codex user config, if present, through codex app-server:');
        system.log(`  config/batchWrite ${JSON.stringify(revokeEdit({ version: '<version from config/read>' }))}`);

        return 'unchecked';
    }

    try {
        return await system.withJsonRpc('codex', ['app-server'], async (rpc): Promise<Revocation> => {
            await rpc.request('initialize', { clientInfo: { name: 'postman-plugin-installer', version: '1' } });
            rpc.notify('initialized');

            const layer = await userLayer(rpc),
                state = layer?.config?.hooks?.state;

            if (!layer || !state || !(POSTMAN_HOOK_KEY in state)) {
                return 'absent';
            }

            // `expectedVersion` makes Codex refuse the write if the file changed after this read.
            await rpc.request('config/batchWrite', revokeEdit({ version: layer.version, file: layer.name.file }, Object.keys(state).length === 1));

            if ((await userLayer(rpc))?.config?.hooks?.state?.[POSTMAN_HOOK_KEY] !== undefined) {
                throw new Error('Codex accepted the write, but the approval is still there');
            }

            return 'removed';
        }) ?? 'unchecked';
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (error instanceof Uncheckable) {
            note(`Could not check ${configFile} for Postman's session-start hook approval: ${reason}.`);

            return 'unchecked';
        }

        note(`Could not delete Postman's hook approval: ${reason}. Remove \`[hooks.state."${POSTMAN_HOOK_KEY}"]\` from ${configFile} yourself.`);

        return 'kept';
    }
}
