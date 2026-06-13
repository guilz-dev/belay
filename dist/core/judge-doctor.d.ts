import type { BelayConfigV4 } from './config.js';
export interface JudgeDoctorResult {
    issues: string[];
    warnings: string[];
    notes: string[];
}
export declare function diagnoseJudge(config: BelayConfigV4): Promise<JudgeDoctorResult>;
