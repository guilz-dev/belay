import type { BelayConfigV3 } from '../config.js';
import type { GatedActionKind } from '../gate-contract.js';
import type { ClassifyResult } from '../types.js';
export declare function isTransactionalEligible(config: BelayConfigV3, kind: GatedActionKind, result: ClassifyResult): boolean;
