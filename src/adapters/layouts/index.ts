import { claudeLayout } from './claude.js'
import { cursorLayout } from './cursor.js'
import type { AdapterLayout, AdapterName } from './types.js'

export { claudeLayout } from './claude.js'
export { cursorLayout } from './cursor.js'
export type { AdapterLayout, AdapterName } from './types.js'

const layouts: Record<AdapterName, AdapterLayout> = {
  cursor: cursorLayout,
  claude: claudeLayout,
}

export function getAdapterLayout(name: AdapterName = 'cursor'): AdapterLayout {
  return layouts[name]
}

export function detectAdapterLayout(
  repoRoot: string,
  existsSync: (path: string) => boolean,
): AdapterLayout {
  if (existsSync(claudeLayout.configPath(repoRoot))) {
    return claudeLayout
  }
  return cursorLayout
}
