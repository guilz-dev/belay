export declare const CODEX_HOOKS_BEGIN = "# --- BELAY MANAGED HOOKS BEGIN (managed by agent-belay; do not edit) ---";
export declare const CODEX_HOOKS_END = "# --- BELAY MANAGED HOOKS END ---";
/**
 * Render belay's Codex lifecycle hooks as a marker-delimited TOML block for `.codex/config.toml`.
 * The block is replaced wholesale on re-init/upgrade (see mergeCodexHooksToml), so we avoid a
 * full TOML parser while staying idempotent.
 */
export declare function renderCodexHooksToml(platform: NodeJS.Platform, hooksDir: string, repoRoot: string): string;
/**
 * Merge belay's managed hooks block into an existing `.codex/config.toml` body idempotently:
 * strip any prior BELAY MANAGED HOOKS block, then append the freshly rendered one.
 */
export declare function mergeCodexHooksToml(existing: string, platform: NodeJS.Platform, hooksDir: string, repoRoot: string): string;
export declare function getCodexManagedHookEntries(platform?: NodeJS.Platform, hooksDir?: string, repoRoot?: string): Array<{
    event: string;
    definition: {
        command: string;
        placement: 'prepend';
        matcher?: string;
    };
}>;
