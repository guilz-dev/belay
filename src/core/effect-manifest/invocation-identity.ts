import { commandIdentityFingerprint } from './command-identity.js'
import { resolveNativeExecutableIdentity } from './executable-identity.js'
import type { EffectManifestV1 } from './types.js'

export function invocationMatchesManifestCommand(
  head: string,
  cwd: string,
  pathEnv: string,
  command: EffectManifestV1['command'],
): boolean {
  // A bare command name may resolve to a shell function or alias before PATH.
  // Only path-qualified invocations have an identity we can verify on disk.
  if (!/[\\/]/.test(head)) {
    return false
  }
  const resolved = resolveNativeExecutableIdentity(head, cwd, pathEnv)
  if ('error' in resolved) {
    return false
  }
  return commandIdentityFingerprint(resolved) === commandIdentityFingerprint(command)
}
