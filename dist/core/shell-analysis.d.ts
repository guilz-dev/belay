import type { PolicyMatch, ShellAttributes } from './policy/types.js';
import type { ClassifierOptions } from './types.js';
export declare function analyzeShellSegment(params: {
    segmentTokens: string[];
    cwd: string;
    repoRoot: string;
    normalizedCommand: string;
    cwdRelative: string;
    options: ClassifierOptions;
    separator?: 'start' | '&&' | '||' | ';' | '|';
    depth?: number;
}): ShellAttributes;
export declare function matchesPolicyRule(match: PolicyMatch, attributes: ShellAttributes): boolean;
