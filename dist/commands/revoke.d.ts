import type { RevokeOptions } from '../types.js';
export declare function revokeApproval(options: RevokeOptions): Promise<{
    ok: boolean;
    message: string;
}>;
