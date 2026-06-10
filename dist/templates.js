import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from './version.js';
function inlineJson(value) {
    return JSON.stringify(value, null, 2);
}
export function renderConfig(config) {
    return `${inlineJson(config)}\n`;
}
export function renderBeforeSubmitHook() {
    return `import { runBeforeSubmitPromptHook } from '../belay/runtime/core.mjs'

await runBeforeSubmitPromptHook()
`;
}
export function renderShellGateHook() {
    return `import { runShellGateHook } from '../belay/runtime/core.mjs'

await runShellGateHook()
`;
}
export function renderToolGateHook() {
    return `import { runToolGateHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'preToolUse'
await runToolGateHook(eventName)
`;
}
export function renderAuditHook() {
    return `import { runAuditHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'postToolUse'
await runAuditHook(eventName)
`;
}
async function readRuntimeBundle() {
    const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bundle', 'cursor-runtime.mjs');
    try {
        return await readFile(bundlePath, 'utf8');
    }
    catch {
        throw new Error('Runtime bundle missing. Run pnpm build before agent-belay init or upgrade.');
    }
}
export async function renderRuntimeCore() {
    const bundle = await readRuntimeBundle();
    const stamp = `export const RUNTIME_BUILD_STAMP = ${JSON.stringify(`${PACKAGE_VERSION}@${new Date().toISOString()}`)};\n`;
    const versionLine = `export const RUNTIME_PACKAGE_VERSION = ${JSON.stringify(PACKAGE_VERSION)};\n`;
    const withoutStamp = bundle
        .replace(/^export const RUNTIME_BUILD_STAMP = .*;\n/gm, '')
        .replace(/^export const RUNTIME_PACKAGE_VERSION = .*;\n/gm, '')
        .replace(/^var RUNTIME_PACKAGE_VERSION = .*;\n/gm, '')
        .replace(/\n  RUNTIME_PACKAGE_VERSION,\n/, '\n');
    return `${versionLine}${stamp}${withoutStamp}`;
}
