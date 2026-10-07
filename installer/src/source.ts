/** Where every host's copy of the plugin comes from. Pi alone installs the npm package instead. */
export const REPO = 'postmanlabs/postman-plugin';
export const GIT_URL = `https://github.com/${REPO}.git`;
/** The branch every clone this installer makes tracks. */
export const BRANCH = 'main';

/** Unpinned, so `pi update` moves it with each `latest` release; test/pi-package.test.js checks the name. */
export const PI_SOURCE = 'npm:@postman/postman-plugin';

/** Generated from this repo's `main` by .github/workflows/opencode-mirror.yml; its root package.json is the plugin. */
export const OPENCODE_REPO = 'postmanlabs/opencode-plugin';

/** What `opencode plugin add` installs: the mirror's default branch. */
export const OPENCODE_SPEC = `github:${OPENCODE_REPO}`;

/** The first OpenCode release of each major that installs `OPENCODE_SPEC`, found by bisecting the harness in opencode/scripts/test-plugin-add.js. */
export const OPENCODE_MINIMUM: Record<number, [number, number, number]> = { 1: [1, 14, 33], 2: [2, 0, 4] };

/** Pre-`plugin add` installs: a clone of the repo plus this one-line loader file. Must stay byte-identical to the shim in opencode/README.md; test/routes.test.js enforces it. */
export const OPENCODE_SHIM = "export { default } from '../postman-plugin/opencode/src/index.ts';\n";

/** Pinned: this third-party CLI writes Kimi's plugin store for us, and an unpinned npx would run whatever is latest. */
export const PLUGINS_CLI = 'plugins@1.3.4';

// A git transport (not `file://`, which names a local path), optional user-info, then
// GitHub's host and its `/`, or the scp-style `git@github.com:` form with no scheme.
const GITHUB_PREFIX = /^(?:(?:https?|ssh|git|git\+ssh|ssh\+git|git\+https):\/\/)?(?:[^@/]+@)?github\.com[:/]/,
    // User-info in a URL, or before an scp-style `host:path`; the conventional `git@` is kept.
    URL_USER_INFO = /^([a-z][a-z+.-]*:\/\/)(?!git@)[^@/]+@/i,
    SCP_USER_INFO = /^(?!git@)[^@/:]+@(?=[^/:]+:)/;

function normalize (source: string): string {
    return source.trim().toLowerCase()
        .replace(GITHUB_PREFIX, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '');
}

/** True for `owner/repo`, or any HTTPS, SSH or git URL of it, with or without `.git`. */
export function isSameRepo (source: string | undefined, repo: string): boolean {
    return typeof source === 'string' && normalize(source) === repo.toLowerCase();
}

/** Strips a URL's user-info, where a token would be, so a source can be printed. */
export function redact (source: string): string {
    return source.replace(URL_USER_INFO, '$1').replace(SCP_USER_INFO, '');
}
