import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import { consumeApprovedEgress, ensurePendingEgressApproval, notifyEgressDeny, } from '../egress-approval.js';
import { loadEgressAllowlist } from './allowlist.js';
import { evaluateEgressConnect } from './policy.js';
function parseHttpTarget(req) {
    if (!req.url) {
        return null;
    }
    try {
        const url = new URL(req.url);
        return {
            host: url.hostname,
            port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
            url,
        };
    }
    catch {
        return null;
    }
}
export function parseConnectTarget(url) {
    if (!url) {
        return null;
    }
    const bracketMatch = url.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracketMatch?.[1]) {
        const port = parseConnectPort(bracketMatch[2]);
        return port ? { host: bracketMatch[1], port } : null;
    }
    const colonIndex = url.lastIndexOf(':');
    if (colonIndex === -1) {
        return { host: url, port: 443 };
    }
    const host = url.slice(0, colonIndex);
    const portValue = url.slice(colonIndex + 1);
    if (!host) {
        return null;
    }
    const port = portValue ? parseConnectPort(portValue) : 443;
    return port ? { host, port } : null;
}
function parseConnectPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }
    return port;
}
async function evaluateRequest(ctx, request) {
    const allowlist = await loadEgressAllowlist(ctx.store.allowlistPath);
    const approved = await ctx.loadApproved();
    const result = evaluateEgressConnect({ request, allowlist, approved });
    if (result.decision === 'allow') {
        if (result.reason === 'approved_once') {
            const consumed = await consumeApprovedEgress({
                repoRoot: ctx.repoRoot,
                fingerprint: result.fingerprint,
                store: ctx.store,
            });
            if (!consumed) {
                const freshApproved = await ctx.loadApproved();
                const retry = evaluateEgressConnect({ request, allowlist, approved: freshApproved });
                if (retry.decision !== 'allow') {
                    return denyEgressRequest(ctx, request, allowlist);
                }
                await ctx.onAudit?.({
                    event: 'egressConnect',
                    kind: 'egress',
                    verdict: 'allow',
                    reason: retry.reason,
                    fingerprint: retry.fingerprint,
                    summary: retry.summary,
                    repoRoot: ctx.repoRoot,
                    permission: 'allow',
                    wouldBlock: false,
                });
                return { allowed: true, result: retry };
            }
            await ctx.onAudit?.({
                event: 'egressConnect',
                kind: 'egress',
                verdict: 'allow',
                reason: 'approved_once',
                fingerprint: result.fingerprint,
                summary: result.summary,
                repoRoot: ctx.repoRoot,
                approvalId: consumed.approvalId,
                permission: 'allow',
                wouldBlock: false,
            });
            return { allowed: true, result };
        }
        await ctx.onAudit?.({
            event: 'egressConnect',
            kind: 'egress',
            verdict: 'allow',
            reason: result.reason,
            fingerprint: result.fingerprint,
            summary: result.summary,
            repoRoot: ctx.repoRoot,
            permission: 'allow',
            wouldBlock: false,
        });
        return { allowed: true, result };
    }
    return denyEgressRequest(ctx, request, allowlist, result);
}
async function denyEgressRequest(ctx, request, allowlist, result) {
    const approved = await ctx.loadApproved();
    const policyResult = result ??
        evaluateEgressConnect({
            request,
            allowlist,
            approved,
        });
    const { approvalId, approval, created } = await ensurePendingEgressApproval({
        config: ctx.config,
        repoRoot: ctx.repoRoot,
        policyResult,
        store: ctx.store,
    });
    if (created) {
        await notifyEgressDeny({
            config: ctx.config,
            repoRoot: ctx.repoRoot,
            policyResult,
            approval,
        });
    }
    await ctx.onAudit?.({
        event: 'egressConnect',
        kind: 'egress',
        verdict: 'deny_pending_approval',
        reason: policyResult.reason,
        fingerprint: policyResult.fingerprint,
        summary: policyResult.summary,
        repoRoot: ctx.repoRoot,
        approvalId,
        permission: 'deny',
        wouldBlock: true,
    });
    return { allowed: false, approvalId, result: policyResult };
}
function denyResponse(res, approvalId, summary) {
    const body = JSON.stringify({
        error: 'egress_blocked',
        message: `Belay blocked egress to ${summary}. Approval ID: ${approvalId}.`,
        approvalId,
    });
    res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}
function forwardHttp(req, res, target) {
    const upstreamPath = `${target.url.pathname}${target.url.search}`;
    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    const proxyReq = http.request({
        host: target.host,
        port: target.port,
        method: req.method,
        path: upstreamPath,
        headers,
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
        res.writeHead(502);
        res.end('Bad gateway');
    });
    req.pipe(proxyReq);
}
export function createEgressProxy(ctx) {
    const server = http.createServer(async (req, res) => {
        const target = parseHttpTarget(req);
        if (!target) {
            res.writeHead(400);
            res.end('Bad request');
            return;
        }
        const evaluation = await evaluateRequest(ctx, {
            host: target.host,
            port: target.port,
            method: (req.method ?? 'GET'),
            repoRoot: ctx.repoRoot,
        });
        if (!evaluation.allowed) {
            denyResponse(res, evaluation.approvalId ?? '', evaluation.result.summary);
            return;
        }
        forwardHttp(req, res, target);
    });
    server.on('connect', (req, clientSocket, head) => {
        void (async () => {
            const target = parseConnectTarget(req.url ?? '');
            if (!target) {
                clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                clientSocket.destroy();
                return;
            }
            const evaluation = await evaluateRequest(ctx, {
                host: target.host,
                port: target.port,
                method: 'CONNECT',
                repoRoot: ctx.repoRoot,
            });
            if (!evaluation.allowed) {
                const body = `Belay blocked egress. Approval ID: ${evaluation.approvalId ?? 'unknown'}`;
                clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
                clientSocket.destroy();
                return;
            }
            const serverSocket = net.connect(target.port, target.host, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) {
                    serverSocket.write(head);
                }
                serverSocket.pipe(clientSocket);
                clientSocket.pipe(serverSocket);
            });
            serverSocket.on('error', () => {
                clientSocket.destroy();
            });
            clientSocket.on('error', () => {
                serverSocket.destroy();
            });
        })();
    });
    return server;
}
export async function startEgressProxy(ctx) {
    const server = createEgressProxy(ctx);
    const host = ctx.config.egress.listenHost;
    const port = ctx.config.egress.listenPort;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
    });
    return { server, port, host };
}
