// OpenCode's config is JSONC: comments and trailing commas are allowed, and users edit it by hand.
// Reading it and removing one array entry from it must therefore leave everything else as written.

type Token = { kind: 'string' | 'punct' | 'other'; start: number; end: number; text: string };

const PUNCTUATION = '{}[]:,',
    WHITESPACE = /\s/;

function tokenize (text: string): Token[] {
    const tokens: Token[] = [];
    let index = text.charCodeAt(0) === 0xFEFF ? 1 : 0;

    while (index < text.length) {
        const char = text[index];

        if (WHITESPACE.test(char)) {
            index += 1;
        }
        else if (text.startsWith('//', index)) {
            const newline = text.indexOf('\n', index);

            index = newline === -1 ? text.length : newline + 1;
        }
        else if (text.startsWith('/*', index)) {
            const close = text.indexOf('*/', index + 2);

            index = close === -1 ? text.length : close + 2;
        }
        else if (char === '"') {
            let end = index + 1;

            while (end < text.length && text[end] !== '"') {
                end += text[end] === '\\' ? 2 : 1;
            }

            tokens.push({ kind: 'string', start: index, end: end + 1, text: text.slice(index, end + 1) });
            index = end + 1;
        }
        else if (PUNCTUATION.includes(char)) {
            tokens.push({ kind: 'punct', start: index, end: index + 1, text: char });
            index += 1;
        }
        else {
            let end = index;

            while (end < text.length && !WHITESPACE.test(text[end]) && !PUNCTUATION.includes(text[end]) && text[end] !== '"' && !text.startsWith('//', end) && !text.startsWith('/*', end)) {
                end += 1;
            }

            tokens.push({ kind: 'other', start: index, end, text: text.slice(index, end) });
            index = end;
        }
    }

    return tokens;
}

/** Parses JSONC; `null` when it is not valid even after comments and trailing commas are dropped. */
export function parseJsonc<T> (text: string): T | null {
    const tokens = tokenize(text);
    let json = '';

    tokens.forEach((token, at) => {
        const next = tokens[at + 1];

        if (token.text === ',' && next && (next.text === ']' || next.text === '}')) {
            return;
        }

        json += token.text;
    });

    try {
        return JSON.parse(json || 'null') as T;
    }
    catch {
        return null;
    }
}

type Element = { start: number; end: number; value: string; before: Token | null; after: Token | null };

/** The direct string elements of the root object's array under `key`, or `null` when there is no such array. */
function stringElements (tokens: Token[], key: string): Element[] | null {
    let depth = 0;

    for (let at = 0; at < tokens.length; at += 1) {
        const token = tokens[at];

        if (token.kind === 'punct' && '{['.includes(token.text)) {
            depth += 1;
        }
        else if (token.kind === 'punct' && '}]'.includes(token.text)) {
            depth -= 1;
        }
        else if (depth === 1 && token.kind === 'string' && tokens[at + 1]?.text === ':' && tokens[at + 2]?.text === '[') {
            let value: unknown;

            try {
                value = JSON.parse(token.text);
            }
            catch {
                continue;
            }

            if (value !== key) {
                continue;
            }

            const elements: Element[] = [];
            let nested = 1;

            for (let inner = at + 3; inner < tokens.length && nested > 0; inner += 1) {
                const item = tokens[inner];

                if (item.kind === 'punct' && '{['.includes(item.text)) {
                    nested += 1;
                }
                else if (item.kind === 'punct' && '}]'.includes(item.text)) {
                    nested -= 1;
                }
                else if (nested === 1 && item.kind === 'string') {
                    elements.push({
                        start: item.start,
                        end: item.end,
                        value: JSON.parse(item.text) as string,
                        before: tokens[inner - 1].text === ',' ? tokens[inner - 1] : null,
                        after: tokens[inner + 1]?.text === ',' ? tokens[inner + 1] : null
                    });
                }
            }

            return elements;
        }
    }

    return null;
}

/** `text` without the first `value` in the array under `key`, comments and layout intact; `null` if it is not there or the result would not parse. */
export function withoutArrayString (text: string, key: string, value: string): string | null {
    const element = stringElements(tokenize(text), key)?.find((entry) => entry.value === value);

    if (!element) {
        return null;
    }

    let start = element.start,
        end = element.end;

    if (element.after) {
        end = element.after.end;

        while (WHITESPACE.test(text[end] ?? '')) {
            end += 1;
        }
    }
    else if (element.before) {
        start = element.before.start;
    }

    const edited = text.slice(0, start) + text.slice(end);

    return parseJsonc(edited) === null ? null : edited;
}
