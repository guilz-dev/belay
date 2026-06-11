import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export async function notifyDeny(config, event) {
    const payload = JSON.stringify(event);
    if (config.webhookUrl) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                await fetch(config.webhookUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: payload,
                    signal: controller.signal,
                });
            }
            finally {
                clearTimeout(timeout);
            }
        }
        catch {
            // best-effort notification
        }
    }
    if (config.commandHook) {
        try {
            await execFileAsync(config.commandHook, [], {
                env: {
                    ...process.env,
                    BELAY_APPROVAL_ID: event.approvalId,
                    BELAY_REASON: event.reason,
                    BELAY_SUMMARY: event.summary,
                    BELAY_REPO_ROOT: event.repoRoot,
                    BELAY_FINGERPRINT: event.fingerprint,
                    BELAY_APPROVAL_TOKEN: event.approvalToken ?? '',
                },
            });
        }
        catch {
            // best-effort notification
        }
    }
}
