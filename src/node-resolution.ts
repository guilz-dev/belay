import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter } from 'node:path'

export interface NodeResolutionResult {
  ok: boolean
  detail: string
  path?: string
}

function isExecutable(path: string | undefined): path is string {
  if (!path) {
    return false
  }
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function firstExecutableInPath(): string | undefined {
  const pathValue = process.env.PATH ?? ''
  for (const segment of pathValue.split(delimiter)) {
    if (!segment) {
      continue
    }
    const candidate = `${segment}/node`
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return undefined
}

function execTool(command: string, args: string[]): string | undefined {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

function resolveViaKnownManagers(): string | undefined {
  const mise = execTool('mise', ['which', 'node'])
  if (isExecutable(mise)) {
    return mise
  }

  const fnm = execTool('fnm', ['which'])
  if (isExecutable(fnm)) {
    return fnm
  }

  const nvmScript =
    process.env.NVM_DIR && existsSync(`${process.env.NVM_DIR}/nvm.sh`)
      ? `${process.env.NVM_DIR}/nvm.sh`
      : existsSync(`${process.env.HOME ?? ''}/.nvm/nvm.sh`)
        ? `${process.env.HOME ?? ''}/.nvm/nvm.sh`
        : undefined
  if (!nvmScript) {
    return undefined
  }

  const command = `. "${nvmScript}" >/dev/null 2>&1 && nvm which current 2>/dev/null`
  const resolved = execTool('/bin/sh', ['-lc', command])
  if (isExecutable(resolved)) {
    return resolved
  }
  return undefined
}

export function resolveNodeBinary(): NodeResolutionResult {
  if (isExecutable(process.execPath)) {
    return {
      ok: true,
      detail: 'Resolved via process.execPath.',
      path: process.execPath,
    }
  }

  const pathNode = firstExecutableInPath()
  if (pathNode) {
    return {
      ok: true,
      detail: 'Resolved via PATH.',
      path: pathNode,
    }
  }

  const managerNode = resolveViaKnownManagers()
  if (managerNode) {
    return {
      ok: true,
      detail: 'Resolved via mise/fnm/nvm.',
      path: managerNode,
    }
  }

  return {
    ok: false,
    detail: 'Unable to resolve Node from process.execPath, PATH, or known managers (mise/fnm/nvm).',
  }
}

export function buildRunnerScript(defaultNodePath: string): string {
  const escapedDefault = defaultNodePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `#!/bin/sh
set -u

DEFAULT_NODE="${escapedDefault}"

resolve_node() {
  if [ -n "$DEFAULT_NODE" ] && [ -x "$DEFAULT_NODE" ]; then
    printf '%s\\n' "$DEFAULT_NODE"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  if command -v mise >/dev/null 2>&1; then
    NODE_FROM_MISE="$(mise which node 2>/dev/null || true)"
    if [ -n "$NODE_FROM_MISE" ] && [ -x "$NODE_FROM_MISE" ]; then
      printf '%s\\n' "$NODE_FROM_MISE"
      return 0
    fi
  fi

  if command -v fnm >/dev/null 2>&1; then
    NODE_FROM_FNM="$(fnm which 2>/dev/null || true)"
    if [ -n "$NODE_FROM_FNM" ] && [ -x "$NODE_FROM_FNM" ]; then
      printf '%s\\n' "$NODE_FROM_FNM"
      return 0
    fi
  fi

  NVM_SCRIPT=""
  if [ -n "\${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    NVM_SCRIPT="$NVM_DIR/nvm.sh"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    NVM_SCRIPT="$HOME/.nvm/nvm.sh"
  fi

  if [ -n "$NVM_SCRIPT" ]; then
    NODE_FROM_NVM="$(/bin/sh -lc ". \\"$NVM_SCRIPT\\" >/dev/null 2>&1 && nvm which current 2>/dev/null" || true)"
    if [ -n "$NODE_FROM_NVM" ] && [ -x "$NODE_FROM_NVM" ]; then
      printf '%s\\n' "$NODE_FROM_NVM"
      return 0
    fi
  fi

  return 1
}

fail_gate() {
  printf '{"permission":"deny","user_message":"agent-belay could not resolve Node. Install or expose Node, run agent-belay doctor, then retry."}\\n'
  exit 0
}

fail_before_submit() {
  printf '{"continue":false,"user_message":"agent-belay could not resolve Node. Install or expose Node, run agent-belay doctor, then retry."}\\n'
  exit 0
}

fail_audit() {
  echo "agent-belay: unable to resolve Node for audit hook" >&2
  printf '{}\\n'
  exit 0
}

HOOK_NAME="\${1:-}"
if [ -z "$HOOK_NAME" ]; then
  fail_audit
fi
shift

NODE_BIN="$(resolve_node || true)"
if [ -z "$NODE_BIN" ]; then
  case "$HOOK_NAME" in
    belay-before-submit)
      fail_before_submit
      ;;
    belay-shell-gate|belay-tool-gate)
      fail_gate
      ;;
    *)
      fail_audit
      ;;
  esac
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
exec "$NODE_BIN" "$SCRIPT_DIR/$HOOK_NAME.mjs" "$@"
`
}

export function buildWindowsRunnerScript(defaultNodePath: string): string {
  const escapedDefault = defaultNodePath.replaceAll('\\', '\\\\')
  return `@echo off
setlocal EnableExtensions

set "DEFAULT_NODE=${escapedDefault}"
set "HOOK_NAME=%~1"
if "%HOOK_NAME%"=="" goto fail_audit
shift

call :resolve_node
if not defined NODE_BIN goto fail_by_hook

"%NODE_BIN%" "%~dp0%HOOK_NAME%.mjs" %*
exit /b 0

:resolve_node
if defined DEFAULT_NODE if exist "%DEFAULT_NODE%" (
  set "NODE_BIN=%DEFAULT_NODE%"
  exit /b 0
)
for %%I in (node.exe) do if not "%%~$PATH:I"=="" (
  set "NODE_BIN=%%~$PATH:I"
  exit /b 0
)
for %%I in ("%USERPROFILE%\\.nvm\\v*\\node.exe") do if exist "%%~fI" (
  set "NODE_BIN=%%~fI"
  exit /b 0
)
exit /b 1

:fail_by_hook
if /I "%HOOK_NAME%"=="belay-before-submit" goto fail_before_submit
if /I "%HOOK_NAME%"=="belay-shell-gate" goto fail_gate
if /I "%HOOK_NAME%"=="belay-tool-gate" goto fail_gate
goto fail_audit

:fail_gate
echo {"permission":"deny","user_message":"agent-belay could not resolve Node. Install or expose Node, run agent-belay doctor, then retry."}
exit /b 0

:fail_before_submit
echo {"continue":false,"user_message":"agent-belay could not resolve Node. Install or expose Node, run agent-belay doctor, then retry."}
exit /b 0

:fail_audit
1>&2 echo agent-belay: unable to resolve Node for audit hook
echo {}
exit /b 0
`
}
