import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultControlPlaneDir } from './config.js';
function base64UrlEncode(value) {
    return Buffer.from(value, 'utf8').toString('base64url');
}
function base64UrlDecode(value) {
    return Buffer.from(value, 'base64url').toString('utf8');
}
export function approvalSigningKeyPath(controlPlaneDir = defaultControlPlaneDir()) {
    return path.join(controlPlaneDir, 'approval-signing.key');
}
export async function loadOrCreateApprovalSigningKey(controlPlaneDir = defaultControlPlaneDir()) {
    const keyPath = approvalSigningKeyPath(controlPlaneDir);
    if (existsSync(keyPath)) {
        return readFile(keyPath);
    }
    await mkdir(controlPlaneDir, { recursive: true });
    const key = randomBytes(32);
    await writeFile(keyPath, key, { mode: 0o600 });
    return key;
}
function signPayload(payload, key) {
    const body = base64UrlEncode(JSON.stringify(payload));
    const signature = createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${signature}`;
}
export async function issueApprovalToken(payload, controlPlaneDir = defaultControlPlaneDir()) {
    const key = await loadOrCreateApprovalSigningKey(controlPlaneDir);
    return signPayload(payload, key);
}
export async function verifyApprovalToken(token, controlPlaneDir = defaultControlPlaneDir()) {
    const [body, signature] = token.split('.');
    if (!body || !signature) {
        return null;
    }
    const keyPath = approvalSigningKeyPath(controlPlaneDir);
    if (!existsSync(keyPath)) {
        return null;
    }
    const key = await readFile(keyPath);
    const expected = createHmac('sha256', key).update(body).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)) {
        return null;
    }
    try {
        const payload = JSON.parse(base64UrlDecode(body));
        if (Date.parse(payload.expiresAt) <= Date.now()) {
            return null;
        }
        return payload;
    }
    catch {
        return null;
    }
}
