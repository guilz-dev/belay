import { claudeAdapter } from './claude/adapter.js'
import { cursorAdapter } from './cursor/adapter.js'
import type { AdapterName } from './layouts/types.js'
import type { BelayAdapter } from './types.js'

const adapters: Record<AdapterName, BelayAdapter> = {
  cursor: cursorAdapter,
  claude: claudeAdapter,
}

export function getAdapter(name: AdapterName = 'cursor'): BelayAdapter {
  return adapters[name]
}

export function listAdapters(): AdapterName[] {
  return Object.keys(adapters) as AdapterName[]
}
