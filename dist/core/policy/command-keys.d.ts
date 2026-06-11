/**
 * Single source for built-in command-key buckets used by analysis and policy rules.
 * L3 noise-reduction cache — not a security boundary. Updates ship in minor releases;
 * see docs/semver-policy.md.
 */
export declare const READ_ONLY_COMMAND_KEYS: readonly ["cat", "cd", "echo", "git diff", "git log", "git rev-parse", "git show", "git status", "head", "ls", "pwd", "rg", "sort", "tail", "wc", "which", "find"];
export declare const FLAGGED_COMMAND_KEYS: readonly ["chmod", "cp", "git add", "git clean", "git commit", "git mv", "git reset", "mkdir", "mv", "rm", "sed", "tee", "touch", "truncate"];
export declare const EXTERNAL_COMMAND_KEYS: readonly ["aws", "curl", "docker push", "docker run", "firebase deploy", "fly deploy", "gh", "git push", "gcloud", "heroku", "kubectl", "netlify", "npm publish", "pnpm publish", "rsync", "scp", "ssh", "supabase", "terraform apply", "vercel", "wget"];
export declare const READ_ONLY_KEYS: Set<string>;
export declare const FLAGGED_KEYS: Set<string>;
export declare const EXTERNAL_KEYS: Set<string>;
