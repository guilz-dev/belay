import type { ParsedSegment } from './parser.js';
import type { InternalSegmentVerdict, VerdictContext } from './types.js';
export declare function matchesCustomPatterns(command: string, segment: ParsedSegment, patterns: string[] | undefined): boolean;
export declare function customAllowMatch(command: string, segment: ParsedSegment, context: VerdictContext): boolean;
export declare function customExternalMatch(command: string, segment: ParsedSegment, context: VerdictContext): boolean;
export declare function allowFromCustomOverride(opacity: InternalSegmentVerdict['opacity']): InternalSegmentVerdict;
export declare function askFromCustomExternal(opacity: InternalSegmentVerdict['opacity']): InternalSegmentVerdict;
