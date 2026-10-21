import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export function acceptsAnswer (answer: string, defaultYes: boolean): boolean {
    return defaultYes ? !/^n/i.test(answer.trim()) : /^(y|yes)$/i.test(answer.trim());
}

export async function confirm (question: string, defaultYes = true): Promise<boolean> {
    const readline = createInterface({ input: stdin, output: stdout });

    try {
        return acceptsAnswer(await readline.question(question), defaultYes);
    }
    finally {
        readline.close();
    }
}
