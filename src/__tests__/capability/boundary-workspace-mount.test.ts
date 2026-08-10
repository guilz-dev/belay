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

function finalDockerEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-e' && args[index + 1]) {
      const [key, ...rest] = args[index + 1].split('=')
      if (key) {
        env[key] = rest.join('=')
      }
    }
  }
  return env
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

  it('rejects mount when host source and guest target are the same path', () => {
    expect(() =>
      validateWorkspaceMount(
        mount({
          hostSourceRoot: '/workspace/project',
          guestTargetRoot: '/workspace/project',
        }),
      ),
    ).toThrow('boundary_workspace_mount_source_equals_target')
  })

  it('sanitizes host-path environment variables when hideHostSourcePath is true', () => {
    const env = finalDockerEnv(workspaceMountEnvArgs(mount()))
    expect(env.PWD).toBe('/workspace/project')
    expect(env.OLDPWD).toBe('/workspace/project')
    expect(env.BELAY_EGRESS_REPO_ROOT).toBe('/workspace/project')
    expect(env.BELAY_REPO_ROOT).toBe('/workspace/project')
    expect(env.BELAY_JUDGE_BROKER_REPO_ROOT).toBe('')
  })
})
