export declare function tokenizeShell(input: string): string[];
export declare function normalizeShellCommand(command: string, repoRoot: string, normalizeToken: (t: string, r: string) => string): string;
export declare function splitTopLevelSegments(tokens: string[]): string[][];
export declare function commandKey(tokens: string[]): string;
export declare function extractRedirectTargets(tokens: string[]): string[];
