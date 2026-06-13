/**
 * Tier0 egress tool classification (SPEC v2.1.3 R33–R34).
 * destructive → Tier0 ask | read → Tier0 allow | ambiguous → Tier1 (fail-closed)
 */
export type EgressClassification = 'destructive' | 'read' | 'ambiguous';
export declare function isEgressToolHead(head: string): boolean;
export declare function classifyEgressTool(head: string, tokens: string[]): EgressClassification | null;
