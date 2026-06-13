import { claudeAdapter } from './claude/adapter.js';
import { codexAdapter } from './codex/adapter.js';
import { cursorAdapter } from './cursor/adapter.js';
const adapters = {
    cursor: cursorAdapter,
    claude: claudeAdapter,
    codex: codexAdapter,
};
export function getAdapter(name = 'cursor') {
    return adapters[name];
}
export function listAdapters() {
    return Object.keys(adapters);
}
