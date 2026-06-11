import type { ManagedHookDefinition } from '../defaults.js'
import type { DoctorOptions, DoctorReport, InitOptions, UpgradeOptions } from '../types.js'
import type { AdapterLayout, AdapterName } from './layouts/types.js'

export interface BelayAdapter {
  name: AdapterName
  layout: AdapterLayout
  install(repoRoot: string, options: InitOptions): Promise<{ repoRoot: string; withSkill: boolean }>
  upgrade(repoRoot: string, options: UpgradeOptions): Promise<{ repoRoot: string }>
  doctor(options: DoctorOptions): Promise<DoctorReport>
  hookEvents(): Array<{ event: string; definition: ManagedHookDefinition }>
}
