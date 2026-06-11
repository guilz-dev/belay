import { claudeLayout } from './claude.js';
import { cursorLayout } from './cursor.js';
export { claudeLayout } from './claude.js';
export { cursorLayout } from './cursor.js';
const layouts = {
    cursor: cursorLayout,
    claude: claudeLayout,
};
export function getAdapterLayout(name = 'cursor') {
    return layouts[name];
}
export function detectAdapterLayout(repoRoot, existsSync) {
    if (existsSync(claudeLayout.configPath(repoRoot))) {
        return claudeLayout;
    }
    return cursorLayout;
}
