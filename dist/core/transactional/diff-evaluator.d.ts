import type { TransactionalDiffContext, TransactionalDiffEvaluation, TransactionalFileChange } from './types.js';
export declare function evaluateTransactionalDiff(changes: TransactionalFileChange[], ctx: TransactionalDiffContext): TransactionalDiffEvaluation;
