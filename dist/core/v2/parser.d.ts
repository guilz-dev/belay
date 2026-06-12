import type { VerdictOpacity } from './types.js';
export interface ParsedSegment {
    tokens: string[];
    head: string;
    key: string;
    normalized: string;
}
export declare function normalizeHead(token: string): string;
export declare function peelTransparentWrappers(tokens: string[]): {
    tokens: string[];
    xargsStdinOpaque: boolean;
};
export declare function isVariableIndirectHead(head: string): boolean;
export declare function extractEvalBody(tokens: string[]): string | null;
export declare function extractRecursiveScript(tokens: string[]): string | null;
export declare function isBareInterpreter(tokens: string[]): boolean;
export declare function splitTopLevelSegments(command: string): string[];
export declare function parseSegment(command: string): ParsedSegment;
export declare function segmentOpacity(command: string): VerdictOpacity;
export declare function substitutionInners(command: string): string[];
export declare function redactCommand(command: string): string;
