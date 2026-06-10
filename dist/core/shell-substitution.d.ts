declare const MAX_SUBSTITUTION_DEPTH = 8;
export { MAX_SUBSTITUTION_DEPTH };
/**
 * Finds inner commands for $(...) and backtick substitution, respecting escapes and nesting.
 */
export declare function findCommandSubstitutions(command: string): string[];
