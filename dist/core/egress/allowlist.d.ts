import type { BelayConfigV3 } from '../config.js';
import type { EgressAllowlistEntry, EgressAllowlistFile } from './types.js';
export declare function egressAllowlistPath(config: BelayConfigV3, repoLocalStateDir: string): string;
export declare function loadEgressAllowlist(filePath: string): Promise<EgressAllowlistFile>;
export declare function saveEgressAllowlist(filePath: string, state: EgressAllowlistFile): Promise<void>;
export declare function isHostAllowlisted(host: string, allowlist: EgressAllowlistFile): boolean;
export declare function addDomainToAllowlist(allowlist: EgressAllowlistFile, entry: EgressAllowlistEntry): EgressAllowlistFile;
