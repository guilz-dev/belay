import type { AdapterName, InitOptions } from '../types.js';
export interface WizardAnswers {
    adapter: AdapterName;
    scope: 'project' | 'global';
    withSkill: boolean;
    dogfood: boolean;
}
export declare function buildInitOptionsFromWizard(answers: WizardAnswers, targetDir?: string): InitOptions;
export declare function runInitWizard(options?: {
    targetDir?: string;
}): Promise<{
    repoRoot: string;
    withSkill: boolean;
    dogfood: boolean;
    adapter: import("../adapters/layouts/types.js").AdapterName;
}>;
