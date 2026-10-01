import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { factory } from './factory.js';
import { kimi } from './kimi.js';
import { opencode } from './opencode.js';
import { pi } from './pi.js';
import type { Host } from './types.js';

export const HOSTS: readonly Host[] = [claudeCode, codex, cursor, factory, kimi, opencode, pi];
