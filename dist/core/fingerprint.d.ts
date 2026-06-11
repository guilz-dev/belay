export declare function canonicalStringify(value: unknown): string;
export declare function hashValue(value: string): string;
export declare function shellFingerprint(cwdRelative: string, normalizedCommand: string): string;
export declare function subagentFingerprint(kind: string, scrubbed: unknown, repoRoot: string): string;
export declare function toolFingerprint(toolName: string, scrubbed: unknown, repoRoot: string): string;
export { egressFingerprint } from './egress/fingerprint.js';
