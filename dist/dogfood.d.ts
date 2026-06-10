import { isDogfoodConfig, loadOperationalInsights } from './operational-insights.js';
import type { DogfoodOptions, DogfoodResult } from './types.js';
export declare function dogfoodProject(options?: DogfoodOptions): Promise<DogfoodResult>;
export declare function formatDogfoodResult(result: DogfoodResult): string;
export declare function formatOperationalInsights(insights: Awaited<ReturnType<typeof loadOperationalInsights>>): Promise<string>;
export { isDogfoodConfig, loadOperationalInsights };
