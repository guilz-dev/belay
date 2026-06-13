import type { ScrubOptions } from '../types.js';
export interface OutboundScrubOptions {
    sensitivePaths: string[];
    scrubOptions: ScrubOptions;
}
export declare function scrubOutboundForJudge(text: string, options: OutboundScrubOptions): {
    ok: true;
    text: string;
} | {
    ok: false;
    reason: string;
};
