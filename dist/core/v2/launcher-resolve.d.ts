export interface LauncherResolution {
    recipes: string[];
    opaque: boolean;
    reason: string;
}
export declare function resolveLauncherRecipe(params: {
    tokens: string[];
    cwd: string;
    repoRoot: string;
    depth: number;
}): LauncherResolution | null;
export declare function isRoutineLauncher(tokens: string[]): boolean;
