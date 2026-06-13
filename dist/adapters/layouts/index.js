import { claudeLayout } from './claude.js';
import { codexLayout } from './codex.js';
import { cursorLayout } from './cursor.js';
export { claudeLayout } from './claude.js';
export { codexLayout } from './codex.js';
export { cursorLayout } from './cursor.js';
const layouts = {
    cursor: cursorLayout,
    claude: claudeLayout,
    codex: codexLayout,
};
export function getAdapterLayout(name = 'cursor') {
    return layouts[name];
}
export function detectAdapterLayout(repoRoot, existsSync) {
    if (existsSync(claudeLayout.configPath(repoRoot))) {
        return claudeLayout;
    }
    if (existsSync(codexLayout.configPath(repoRoot))) {
        return codexLayout;
    }
    return cursorLayout;
}
