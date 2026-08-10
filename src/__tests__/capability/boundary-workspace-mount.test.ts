import { describe, expect, it } from 'vitest'
import type { BoundaryWorkspaceMount } from '../../core/capability/boundary-run.js'
import {
  buildWorkspaceMountSpec,
  resolveGuestWorkdir,
  validateWorkspaceMount,
  workspaceMountEnvArgs,
} from '../../core/capability/boundary-workspace-mount.js'

function mount(overrides?: Partial<BoundaryWorkspaceMount>): BoundaryWorkspaceMount {
  return {
    hostSourceRoot: '/tmp/belay-mirror',
    guestTargetRoot: '/workspace/project',
    cwdRelative: '.',
    writable: true,
    hideHostSourcePath: true,
    ...overrides,
  }
}

describe('boundary workspace mount helpers', () => {
  it('builds a bind mount spec for the execution mirror', () => {
    expect(buildWorkspaceMountSpec(mount())).toBe(
      'type=bind,src=/tmp/belay-mirror,dst=/workspace/project,rw',
    )
  })

  it('resolves guest workdir from cwdRelative', () => {
    expect(resolveGuestWorkdir(mount({ cwdRelative: 'src/pkg' }))).toBe(
      '/workspace/project/src/pkg',
    )
    expect(resolveGuestWorkdir(mount({ cwdRelative: './' }))).toBe('/workspace/project')
  })

  it('rejects cwdRelative that escapes the guest root', () => {
    expect(() => validateWorkspaceMount(mount({ cwdRelative: '../outside' }))).toThrow(
      'boundary_workspace_mount_invalid_cwd',
    )
  })

  it('sanitizes host-path environment variables when hideHostSourcePath is true', () => {
    const args = workspaceMountEnvArgs(mount())
    expect(args).toContain('-e')
    expect(args).toContain('PWD=/workspace/project')
    expect(args).toContain('OLDPWD=/workspace/project')
    expect(args).toContain('BELAY_EGRESS_REPO_ROOT=/workspace/project')
    expect(args).toContain('BELAY_REPO_ROOT=/workspace/project')
    expect(args).toContain('BELAY_JUDGE_BROKER_REPO_ROOT=')
  })
})
