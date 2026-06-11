import path from 'node:path';
/** Repo-local and optional out-of-repo paths that must never be mutated via overrides. */
export function protectedArtifactRoots(layout, repoRoot, controlPlaneDir) {
    const roots = [
        layout.configPath(repoRoot),
        layout.hooksSettingsPath(repoRoot),
        layout.hooksDir(repoRoot),
        layout.repoLocalStateDir(repoRoot),
        layout.runtimeDir(repoRoot),
    ];
    if (controlPlaneDir) {
        roots.push(controlPlaneDir);
    }
    return roots.map((entry) => path.resolve(entry));
}
