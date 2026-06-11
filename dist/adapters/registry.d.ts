import type { AdapterName } from './layouts/types.js';
import type { BelayAdapter } from './types.js';
export declare function getAdapter(name?: AdapterName): BelayAdapter;
export declare function listAdapters(): AdapterName[];
