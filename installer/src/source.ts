/** Where every host's copy of the plugin comes from. The npm package carries no skills. */
export const REPO = 'postmanlabs/postman-plugin';
export const GIT_URL = `https://github.com/${REPO}.git`;

/** Must stay byte-identical to the shim in opencode/README.md; test/routes.test.js enforces it. */
export const OPENCODE_SHIM = "export { default } from '../postman-plugin/opencode/src/index.ts';\n";

/** Pinned: this third-party CLI writes Kimi's plugin store for us, and an unpinned npx would run whatever is latest. */
export const PLUGINS_CLI = 'plugins@1.3.4';

function normalize (source: string): string {
    return source.trim().toLowerCase()
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^https?:\/\/github\.com\//, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
}

/** True for `owner/repo`, its HTTPS or SSH git URL, with or without `.git`. */
export function isSameRepo (source: string | undefined, repo: string): boolean {
    return typeof source === 'string' && normalize(source) === repo.toLowerCase();
}
