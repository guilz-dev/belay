export type LayerProfileId = 'l3-l4-only' | 'l1-partial-egress' | 'l1-l2-transactional' | 'l1-full'

export interface LayerConformanceScenario {
  command: string
  permission: 'allow' | 'deny'
  reason?: string
  /** When true, layer-matrix tests seed a live egress daemon before evaluation. */
  requiresEgressProxy?: boolean
}
