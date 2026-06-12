export interface SimulateOptions {
    targetDir?: string;
    configPath: string;
    json?: boolean;
}
export declare function simulateProject(options: SimulateOptions): Promise<{
    candidateConfigPath: string;
    totalRecords: number;
    changedCount: number;
    allowToDenyCount: number;
    denyToAllowCount: number;
    diffs: import("../core/reclassify.js").ReclassifyDiff[];
}>;
export declare function formatSimulateReport(report: Awaited<ReturnType<typeof simulateProject>>): string;
