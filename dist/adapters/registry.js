import { claudeAdapter } from './claude/adapter.js';
import { cursorAdapter } from './cursor/adapter.js';
const adapters = {
    cursor: cursorAdapter,
    claude: claudeAdapter,
};
export function getAdapter(name = 'cursor') {
    return adapters[name];
}
export function listAdapters() {
    return Object.keys(adapters);
}
