import type { AdapterLayout, AdapterName } from './types.js';
export { claudeLayout } from './claude.js';
export { codexLayout } from './codex.js';
export { cursorLayout } from './cursor.js';
export type { AdapterLayout, AdapterName } from './types.js';
export declare function getAdapterLayout(name?: AdapterName): AdapterLayout;
export declare function detectAdapterLayout(repoRoot: string, existsSync: (path: string) => boolean): AdapterLayout;
