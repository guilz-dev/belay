import { existsSync } from 'node:fs';
import path from 'node:path';
export function findRepoRoot(startPath, layout) {
    let current = path.resolve(startPath);
    while (true) {
        for (const marker of layout.repoRootMarkers) {
            if (existsSync(path.join(current, marker))) {
                return current;
            }
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startPath);
        }
        current = parent;
    }
}
