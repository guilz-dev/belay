import type { ManagedHookDefinition } from '../defaults.js'
import type { DoctorOptions, DoctorReport, InitOptions } from '../types.js'

export interface BelayAdapter {
  name: string
  install(repoRoot: string, options: InitOptions): Promise<{ repoRoot: string; withSkill: boolean }>
  upgrade(repoRoot: string, options: InitOptions): Promise<{ repoRoot: string }>
  doctor(options: DoctorOptions): Promise<DoctorReport>
  hookEvents(): Array<{ event: string; definition: ManagedHookDefinition }>
}
