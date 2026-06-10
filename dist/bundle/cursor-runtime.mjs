// agent-belay cursor runtime bundle

// src/adapters/cursor/runtime-entry.ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path3 from "node:path";
import process from "node:process";

// src/core/approval.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function isExpired(approval) {
  return Date.parse(approval.expiresAt) <= Date.now();
}
function compactApprovals(state) {
  return {
    version: 1,
    approvals: state.approvals.filter((approval) => !isExpired(approval))
  };
}
function escapeRegex(value) {
  const specials = /* @__PURE__ */ new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
  return [...value].map((char) => specials.has(char) ? `\\${char}` : char).join("");
}
function approvalCommandMatch(prompt, tokenPrefix) {
  const escapedPrefix = escapeRegex(tokenPrefix);
  const match = prompt.match(new RegExp(`^\\s*${escapedPrefix}\\s+(\\S+)\\s*$`, "i"));
  return match?.[1] ?? null;
}
function buildRetryInstruction(tokenPrefix, approvalId) {
  return `To allow the next matching action once, send ${tokenPrefix} ${approvalId} and then retry the original action unchanged.`;
}
function createApprovalRecord(params) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + params.approvalTtlMinutes * 6e4).toISOString();
  return {
    approvalId: params.approvalId,
    kind: params.kind,
    fingerprint: params.fingerprint,
    repoRoot: params.repoRoot,
    reason: params.reason,
    summary: params.summary,
    createdAt,
    expiresAt
  };
}

// src/core/fingerprint.ts
import { createHash } from "node:crypto";
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`).join(",")}}`;
}
function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}
function shellFingerprint(cwdRelative, normalizedCommand) {
  return hashValue(`shell:${cwdRelative}:${normalizedCommand}`);
}
function subagentFingerprint(kind, scrubbed, repoRoot) {
  return hashValue(`subagent:${kind}:${canonicalStringify(scrubbed)}:${repoRoot}`);
}
function toolFingerprint(toolName, scrubbed, repoRoot) {
  return hashValue(`tool:${toolName}:${canonicalStringify(scrubbed)}:${repoRoot}`);
}

// src/core/path-utils.ts
import path from "node:path";
function relativeWithinRepo(repoRoot, targetPath) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  if (relativePath === "") {
    return ".";
  }
  if (relativePath.startsWith("..")) {
    return null;
  }
  return relativePath;
}
function normalizeToken(token, repoRoot) {
  if (!path.isAbsolute(token)) {
    return token;
  }
  const relativePath = relativeWithinRepo(repoRoot, token);
  return relativePath ?? token;
}
function resolveMutationTarget(token, cwd) {
  if (!token || token === "--" || token.startsWith("-")) {
    return null;
  }
  if (token === "2>" || token === "1>" || token === "&>" || token === "1>>" || token === "2>>") {
    return null;
  }
  if (path.isAbsolute(token)) {
    return path.resolve(token);
  }
  if (token.startsWith("./") || token.startsWith("../")) {
    return path.resolve(cwd, token);
  }
  return null;
}
function hasOutsideRepoPath(tokens, cwd, repoRoot) {
  return tokens.some((token) => {
    const resolved = resolveMutationTarget(token, cwd);
    if (!resolved) {
      return false;
    }
    return relativeWithinRepo(repoRoot, resolved) === null;
  });
}

// src/core/shell-tokenizer.ts
var ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/;
function tokenizeShell(input) {
  const tokens = [];
  let buffer = "";
  let quote = null;
  let escaping = false;
  const flush = () => {
    if (buffer.length > 0) {
      tokens.push(buffer);
      buffer = "";
    }
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1] ?? "";
    if (escaping) {
      buffer += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        buffer += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "&" && next === "&") {
      flush();
      tokens.push("&&");
      index += 1;
      continue;
    }
    if (char === "|" && next === "|") {
      flush();
      tokens.push("||");
      index += 1;
      continue;
    }
    if (char === ">" && next === ">") {
      flush();
      tokens.push(">>");
      index += 1;
      continue;
    }
    if (char === "|" || char === ";" || char === ">" || char === "<") {
      flush();
      tokens.push(char);
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    buffer += char;
  }
  flush();
  return tokens;
}
function normalizeShellCommand(command, repoRoot, normalizeToken2) {
  const tokens = tokenizeShell(command);
  while (tokens.length > 0 && ENV_PREFIX_PATTERN.test(tokens[0] ?? "")) {
    tokens.shift();
  }
  const normalized = tokens.map((token) => normalizeToken2(token, repoRoot));
  return normalized.join(" ").trim();
}
function commandKey(tokens) {
  const filtered = tokens.filter((token) => token !== "sudo");
  const first = filtered[0] ?? "";
  const second = filtered[1] ?? "";
  if ((first === "git" || first === "npm" || first === "pnpm" || first === "docker" || first === "terraform" || first === "fly" || first === "firebase") && second) {
    return `${first} ${second}`;
  }
  return first;
}
function extractRedirectTargets(tokens) {
  const targets = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === ">" || token === ">>" || token === "<") {
      const next = tokens[index + 1];
      if (next) {
        targets.push(next);
      }
    }
  }
  return targets;
}

// src/core/classify-shell.ts
var READ_ONLY_COMMANDS = /* @__PURE__ */ new Set([
  "cat",
  "cd",
  "echo",
  "find",
  "git diff",
  "git log",
  "git rev-parse",
  "git show",
  "git status",
  "head",
  "ls",
  "node",
  "pwd",
  "rg",
  "sed",
  "sort",
  "tail",
  "wc",
  "which"
]);
var FLAGGED_COMMANDS = /* @__PURE__ */ new Set([
  "chmod",
  "cp",
  "git add",
  "git clean",
  "git commit",
  "git mv",
  "git reset",
  "mkdir",
  "mv",
  "rm",
  "tee",
  "touch",
  "truncate"
]);
var EXTERNAL_COMMANDS = /* @__PURE__ */ new Set([
  "aws",
  "curl",
  "docker push",
  "docker run",
  "firebase deploy",
  "fly deploy",
  "gh",
  "git push",
  "gcloud",
  "heroku",
  "kubectl",
  "netlify",
  "npm publish",
  "pnpm publish",
  "rsync",
  "scp",
  "ssh",
  "supabase",
  "terraform apply",
  "vercel",
  "wget"
]);
var SHELL_INTERPRETERS = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "fish"]);
var EXTERNAL_SCRIPT_TERMS = ["deploy", "publish", "release", "ship", "prod"];
var VERDICT_RANK = {
  allow: 0,
  allow_flagged: 1,
  deny_pending_approval: 2
};
function worseVerdict(left, right) {
  const leftRank = VERDICT_RANK[left.verdict] ?? 0;
  const rightRank = VERDICT_RANK[right.verdict] ?? 0;
  if (rightRank > leftRank) {
    return right;
  }
  if (rightRank < leftRank) {
    return left;
  }
  return right;
}
function denyResult(params) {
  return {
    verdict: "deny_pending_approval",
    reason: params.reason,
    normalizedCommand: params.normalizedCommand,
    fingerprint: shellFingerprint(params.cwdRelative, params.normalizedCommand),
    assessment: params.assessment
  };
}
function splitSegmentsWithSeparators(tokens) {
  const segments = [];
  let current = [];
  let separator = "start";
  const flush = () => {
    if (current.length > 0) {
      segments.push({ tokens: current, separator });
      current = [];
    }
  };
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === ";" || token === "|") {
      flush();
      separator = token;
      continue;
    }
    current.push(token);
  }
  flush();
  return segments;
}
function isExternalKey(key, options) {
  return EXTERNAL_COMMANDS.has(key) || (options.customExternalCommands ?? []).some((c) => c === key);
}
function classifySegment(segment, cwd, repoRoot, normalizedCommand, cwdRelative, options) {
  const segmentTokens = segment.tokens;
  const key = commandKey(segmentTokens);
  const redirects = extractRedirectTargets(segmentTokens);
  const signals = [];
  for (const custom of options.customAllowCommands ?? []) {
    if (normalizedCommand.includes(custom) || key === custom) {
      return {
        verdict: "allow",
        reason: "custom_allow",
        normalizedCommand,
        fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
        assessment: {
          reversibility: "reversible",
          external: false,
          blastRadius: "this repository",
          confidence: 0.99,
          signals: ["custom_allow_command"]
        }
      };
    }
  }
  for (const custom of options.customExternalCommands ?? []) {
    if (normalizedCommand.includes(custom) || key === custom) {
      return denyResult({
        reason: "custom_external",
        normalizedCommand,
        cwdRelative,
        assessment: {
          reversibility: "irreversible",
          external: true,
          blastRadius: "custom external command",
          confidence: 0.95,
          signals: ["custom_external_command"]
        }
      });
    }
  }
  const hasOutsideRedirect = redirects.some((target) => {
    const resolved = resolveMutationTarget(target, cwd);
    if (!resolved) {
      return false;
    }
    return relativeWithinRepo(repoRoot, resolved) === null;
  });
  if (hasOutsideRedirect) {
    signals.push("outside_repo_redirect");
    return denyResult({
      reason: "outside_repo_redirect",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: true,
        blastRadius: "outside the repository",
        confidence: 0.92,
        signals
      }
    });
  }
  if (FLAGGED_COMMANDS.has(key) && hasOutsideRepoPath(segmentTokens.slice(1), cwd, repoRoot)) {
    signals.push("outside_repo_mutation");
    return denyResult({
      reason: "outside_repo_mutation",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: true,
        blastRadius: "outside the repository",
        confidence: 0.9,
        signals
      }
    });
  }
  if (segment.separator === "|" && SHELL_INTERPRETERS.has(key)) {
    signals.push("pipe_to_shell");
    return denyResult({
      reason: "pipe_to_shell",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: true,
        blastRadius: "shell interpreter via pipe",
        confidence: 0.94,
        signals
      }
    });
  }
  if ((key === "npm run" || key === "pnpm run") && segmentTokens[2]) {
    const scriptName = segmentTokens[2].toLowerCase();
    if (EXTERNAL_SCRIPT_TERMS.some((term) => scriptName.includes(term))) {
      signals.push("external_script_name", scriptName);
      return denyResult({
        reason: "external_script",
        normalizedCommand,
        cwdRelative,
        assessment: {
          reversibility: "irreversible",
          external: true,
          blastRadius: `npm script: ${scriptName}`,
          confidence: 0.88,
          signals
        }
      });
    }
  }
  if (key === "curl" || key === "wget") {
    const hasAuthHeader = segmentTokens.some(
      (token) => token === "-H" || token === "--header" || /authorization/i.test(token)
    );
    if (hasAuthHeader) {
      signals.push("credential_header");
      return {
        verdict: "allow_flagged",
        reason: "credential_header",
        normalizedCommand,
        fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
        assessment: {
          reversibility: "recoverable_with_cost",
          external: true,
          blastRadius: "external request with credentials",
          confidence: 0.75,
          signals
        }
      };
    }
  }
  if (isExternalKey(key, options)) {
    signals.push("external_command", key);
    return denyResult({
      reason: "external_effect",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: true,
        blastRadius: key === "git push" ? "remote origin" : "external system",
        confidence: 0.92,
        signals
      }
    });
  }
  if (READ_ONLY_COMMANDS.has(key)) {
    return {
      verdict: "allow",
      reason: "read_only",
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: "reversible",
        external: false,
        blastRadius: "this repository",
        confidence: 0.95,
        signals: ["read_only_command"]
      }
    };
  }
  if (FLAGGED_COMMANDS.has(key) || redirects.length > 0) {
    signals.push("local_mutation");
    return {
      verdict: "allow_flagged",
      reason: "local_mutation",
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: "recoverable_with_cost",
        external: false,
        blastRadius: "this repository",
        confidence: 0.72,
        signals
      }
    };
  }
  signals.push("unknown_local_effect");
  return {
    verdict: "allow_flagged",
    reason: "unknown_local_effect",
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
    assessment: {
      reversibility: "recoverable_with_cost",
      external: false,
      blastRadius: "this repository",
      confidence: 0.61,
      signals
    }
  };
}
function classifyShell(command, cwd, repoRoot, options = {}) {
  const tokens = tokenizeShell(command);
  const segments = splitSegmentsWithSeparators(tokens);
  const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken);
  const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd;
  let effective = {
    verdict: "allow",
    reason: "read_only",
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
    assessment: {
      reversibility: "reversible",
      external: false,
      blastRadius: "this repository",
      confidence: 0.95,
      signals: ["read_only"]
    }
  };
  for (let index = 0; index < segments.length; index += 1) {
    const result = classifySegment(
      segments[index],
      cwd,
      repoRoot,
      normalizedCommand,
      cwdRelative,
      options
    );
    effective = worseVerdict(effective, result);
    if (result.verdict === "deny_pending_approval" && options.strictChains !== true) {
      return result;
    }
  }
  return effective;
}

// src/core/scrub.ts
var UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
var TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
var APPROVAL_ID_PATTERN = /\bbelay_[a-z0-9]{8,}\b/gi;
var TOKEN_PREFIX_PATTERN = /\/belay-approve\s+\S+/gi;
function scrubString(value) {
  return value.replace(UUID_PATTERN, "<uuid>").replace(TIMESTAMP_PATTERN, "<timestamp>").replace(APPROVAL_ID_PATTERN, "<approval-id>").replace(TOKEN_PREFIX_PATTERN, "/belay-approve <approval-id>");
}
function scrubValue(value) {
  if (typeof value === "string") {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = scrubValue(child);
    }
    return result;
  }
  return value;
}

// src/core/classify-subagent.ts
var EXTERNAL_PHRASES = [
  "deploy to production",
  "deploy to prod",
  "publish to npm",
  "publish package",
  "release to production",
  "ship to production",
  "send email",
  "notify slack",
  "call external api",
  "push to production",
  "push to prod"
];
var INVESTIGATION_PHRASES = [
  "investigate",
  "debug",
  "research",
  "review",
  "analyze",
  "analyse",
  "check",
  "look into",
  "understand",
  "explore"
];
var EXTERNAL_TERMS = [
  "deploy",
  "production",
  "publish",
  "release",
  "ship",
  "notify",
  "email",
  "prod"
];
function extractSubagentText(payload) {
  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const input = toolInput;
    const description = typeof input.description === "string" ? input.description : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    return [description, prompt].filter(Boolean).join(" ");
  }
  const task = payload.task;
  if (typeof task === "string") {
    return task;
  }
  if (task && typeof task === "object") {
    const taskObj = task;
    const description = typeof taskObj.description === "string" ? taskObj.description : "";
    const prompt = typeof taskObj.prompt === "string" ? taskObj.prompt : "";
    return [description, prompt].filter(Boolean).join(" ");
  }
  return canonicalStringify(scrubValue(payload));
}
function fingerprintSource(payload) {
  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const input = toolInput;
    return scrubValue({
      description: input.description ?? "",
      prompt: input.prompt ?? ""
    });
  }
  const task = payload.task;
  if (typeof task === "string") {
    return scrubValue({ task });
  }
  if (task && typeof task === "object") {
    const taskObj = task;
    return scrubValue({
      description: taskObj.description ?? "",
      prompt: taskObj.prompt ?? ""
    });
  }
  return scrubValue(payload);
}
function classifySubagent(payload, repoRoot, _options = {}) {
  const kind = payload.tool_name === "Task" ? "Task" : String(payload.subagent_type ?? "generalPurpose");
  const scrubbed = fingerprintSource(payload);
  const summary = extractSubagentText(payload);
  const lowered = summary.toLowerCase();
  const fingerprint = subagentFingerprint(kind, scrubbed, repoRoot);
  const signals = [];
  for (const phrase of EXTERNAL_PHRASES) {
    if (lowered.includes(phrase)) {
      signals.push("external_phrase", phrase);
      return {
        verdict: "deny_pending_approval",
        reason: "external_subagent_intent",
        summary,
        fingerprint,
        assessment: {
          reversibility: "irreversible",
          external: true,
          blastRadius: "subagent requested external effect",
          confidence: 0.92,
          signals
        }
      };
    }
  }
  const isInvestigation = INVESTIGATION_PHRASES.some((phrase) => lowered.includes(phrase));
  const hasExternalTerm = EXTERNAL_TERMS.some((term) => {
    const pattern = new RegExp(`\\b${term}\\b`, "i");
    return pattern.test(lowered);
  });
  if (hasExternalTerm && !isInvestigation) {
    signals.push("external_term");
    return {
      verdict: "deny_pending_approval",
      reason: "external_subagent_intent",
      summary,
      fingerprint,
      assessment: {
        reversibility: "irreversible",
        external: true,
        blastRadius: "subagent requested external effect",
        confidence: 0.85,
        signals
      }
    };
  }
  if (hasExternalTerm && isInvestigation) {
    signals.push("external_term_investigation_context");
    return {
      verdict: "allow_flagged",
      reason: "subagent_review",
      summary,
      fingerprint,
      assessment: {
        reversibility: "recoverable_with_cost",
        external: false,
        blastRadius: "subagent task scope",
        confidence: 0.7,
        signals
      }
    };
  }
  return {
    verdict: "allow_flagged",
    reason: "subagent_review",
    summary,
    fingerprint,
    assessment: {
      reversibility: "recoverable_with_cost",
      external: false,
      blastRadius: "subagent task scope",
      confidence: 0.67,
      signals: ["subagent_default_review"]
    }
  };
}

// src/core/classify-tool.ts
import path2 from "node:path";

// src/core/glob.ts
function matchesSensitivePath(filePath, patterns) {
  const normalized = filePath.replaceAll("\\", "/");
  const baseName = normalized.split("/").pop() ?? normalized;
  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll("\\", "/");
    if (normalizedPattern.includes("**")) {
      const suffix = normalizedPattern.replace("**/", "");
      if (normalized.includes(suffix) || normalized.endsWith(suffix)) {
        return true;
      }
    }
    if (normalizedPattern.includes("*")) {
      const regex = new RegExp(
        `^${normalizedPattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`
      );
      if (regex.test(normalized) || regex.test(baseName)) {
        return true;
      }
    }
    if (normalized === normalizedPattern || baseName === normalizedPattern) {
      return true;
    }
    if (normalized.endsWith(`/${normalizedPattern}`)) {
      return true;
    }
  }
  return false;
}

// src/core/classify-tool.ts
var DEFAULT_SENSITIVE_PATHS = [".env", ".env.*", "**/credentials/**"];
function extractFilePath(payload) {
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const input = toolInput;
  for (const key of ["path", "file_path", "target_file", "filePath"]) {
    if (typeof input[key] === "string") {
      return input[key];
    }
  }
  return null;
}
function extractShellCommand(payload) {
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const input = toolInput;
  if (typeof input.command === "string") {
    return input.command;
  }
  return null;
}
function classifyToolUse(payload, repoRoot, cwd, options = {}) {
  const toolName = String(payload.tool_name ?? "");
  const sensitivePaths = [...DEFAULT_SENSITIVE_PATHS, ...options.sensitivePaths ?? []];
  if (toolName === "Shell") {
    const command = extractShellCommand(payload);
    if (!command) {
      return {
        verdict: "allow_flagged",
        reason: "tool_shell_missing_command",
        summary: canonicalStringify(scrubValue(payload.tool_input ?? {})),
        fingerprint: toolFingerprint(toolName, scrubValue(payload.tool_input ?? {}), repoRoot),
        assessment: {
          reversibility: "recoverable_with_cost",
          external: false,
          blastRadius: "tool shell",
          confidence: 0.5,
          signals: ["missing_command"]
        }
      };
    }
    const shellResult = classifyShell(command, cwd, repoRoot, options);
    return {
      ...shellResult,
      fingerprint: toolFingerprint(toolName, { command }, repoRoot),
      summary: command
    };
  }
  if (toolName === "Write" || toolName === "StrReplace" || toolName === "Delete") {
    const filePath = extractFilePath(payload);
    if (!filePath) {
      return {
        verdict: "allow_flagged",
        reason: "file_mutation_missing_path",
        summary: canonicalStringify(scrubValue(payload.tool_input ?? {})),
        fingerprint: toolFingerprint(toolName, scrubValue(payload.tool_input ?? {}), repoRoot),
        assessment: {
          reversibility: "recoverable_with_cost",
          external: false,
          blastRadius: "file mutation",
          confidence: 0.55,
          signals: ["missing_path"]
        }
      };
    }
    const signals = [];
    const resolvedPath = path2.isAbsolute(filePath) ? filePath : path2.join(repoRoot, filePath);
    const relativePath = relativeWithinRepo(repoRoot, resolvedPath);
    if (relativePath === null) {
      signals.push("outside_repo_path");
      return {
        verdict: "deny_pending_approval",
        reason: "outside_repo_file_mutation",
        summary: filePath,
        fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
        assessment: {
          reversibility: "irreversible",
          external: true,
          blastRadius: "outside the repository",
          confidence: 0.9,
          signals
        }
      };
    }
    if (matchesSensitivePath(relativePath, sensitivePaths)) {
      signals.push("sensitive_path");
      return {
        verdict: "deny_pending_approval",
        reason: "sensitive_file_mutation",
        summary: filePath,
        fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
        assessment: {
          reversibility: "irreversible",
          external: false,
          blastRadius: "sensitive repository file",
          confidence: 0.88,
          signals
        }
      };
    }
    if (toolName === "Delete") {
      signals.push("file_delete");
      return {
        verdict: "allow_flagged",
        reason: "file_delete",
        summary: filePath,
        fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
        assessment: {
          reversibility: "recoverable_with_cost",
          external: false,
          blastRadius: "this repository",
          confidence: 0.7,
          signals
        }
      };
    }
    signals.push("file_mutation");
    return {
      verdict: "allow_flagged",
      reason: "file_mutation",
      summary: filePath,
      fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
      assessment: {
        reversibility: "recoverable_with_cost",
        external: false,
        blastRadius: "this repository",
        confidence: 0.68,
        signals
      }
    };
  }
  return {
    verdict: "allow",
    reason: "unclassified_tool",
    summary: canonicalStringify(scrubValue(payload.tool_input ?? {})),
    fingerprint: toolFingerprint(toolName, scrubValue(payload.tool_input ?? {}), repoRoot),
    assessment: {
      reversibility: "reversible",
      external: false,
      blastRadius: "tool scope",
      confidence: 0.5,
      signals: ["unclassified_tool"]
    }
  };
}

// src/core/config.ts
var DEFAULT_CONFIG_V2 = {
  version: 2,
  mode: "enforce",
  approvalTtlMinutes: 15,
  tokenPrefix: "/belay-approve",
  gates: {
    shell: true,
    subagent: true,
    fileMutation: true,
    toolShell: true
  },
  classifier: {
    strictChains: true,
    customExternalCommands: [],
    customAllowCommands: [],
    sensitivePaths: [".env", ".env.*", "**/credentials/**"]
  },
  audit: {
    logPath: ".cursor/belay/audit.ndjson",
    includeAssessment: true
  }
};
function migrateConfig(loaded) {
  if (typeof loaded !== "object" || loaded === null) {
    return { ...DEFAULT_CONFIG_V2 };
  }
  const raw = loaded;
  const base = { ...DEFAULT_CONFIG_V2 };
  if (raw.version === 1 || raw.version === void 0) {
    return normalizeConfig({
      ...base,
      mode: raw.mode ?? base.mode,
      approvalTtlMinutes: raw.approvalTtlMinutes ?? base.approvalTtlMinutes,
      tokenPrefix: raw.tokenPrefix ?? base.tokenPrefix,
      gates: {
        ...base.gates,
        shell: raw.gates?.shell ?? base.gates.shell,
        subagent: raw.gates?.subagent ?? base.gates.subagent
      },
      audit: {
        ...base.audit,
        logPath: raw.audit?.logPath ?? base.audit.logPath
      }
    });
  }
  return normalizeConfig({
    ...base,
    ...raw,
    version: 2,
    gates: {
      ...base.gates,
      ...raw.gates ?? {}
    },
    classifier: {
      ...base.classifier,
      ...raw.classifier ?? {}
    },
    audit: {
      ...base.audit,
      ...raw.audit ?? {}
    }
  });
}
function normalizeConfig(config) {
  return {
    version: 2,
    mode: config.mode === "audit" ? "audit" : "enforce",
    approvalTtlMinutes: typeof config.approvalTtlMinutes === "number" && config.approvalTtlMinutes > 0 ? config.approvalTtlMinutes : DEFAULT_CONFIG_V2.approvalTtlMinutes,
    tokenPrefix: config.tokenPrefix || DEFAULT_CONFIG_V2.tokenPrefix,
    gates: {
      shell: config.gates.shell !== false,
      subagent: config.gates.subagent !== false,
      fileMutation: config.gates.fileMutation !== false,
      toolShell: config.gates.toolShell !== false
    },
    classifier: {
      strictChains: config.classifier?.strictChains !== false,
      customExternalCommands: Array.isArray(config.classifier?.customExternalCommands) ? config.classifier.customExternalCommands : [],
      customAllowCommands: Array.isArray(config.classifier?.customAllowCommands) ? config.classifier.customAllowCommands : [],
      sensitivePaths: Array.isArray(config.classifier?.sensitivePaths) ? config.classifier.sensitivePaths : DEFAULT_CONFIG_V2.classifier.sensitivePaths
    },
    audit: {
      logPath: config.audit?.logPath || DEFAULT_CONFIG_V2.audit.logPath,
      includeAssessment: config.audit?.includeAssessment !== false
    }
  };
}
function mergeConfig(existing, defaults = DEFAULT_CONFIG_V2) {
  const migrated = migrateConfig(existing);
  return normalizeConfig({
    ...defaults,
    ...migrated,
    gates: {
      ...defaults.gates,
      ...migrated.gates
    },
    classifier: {
      ...defaults.classifier,
      ...migrated.classifier
    },
    audit: {
      ...defaults.audit,
      ...migrated.audit
    }
  });
}
function classifierOptionsFromConfig(config) {
  return {
    strictChains: config.classifier.strictChains,
    customExternalCommands: config.classifier.customExternalCommands,
    customAllowCommands: config.classifier.customAllowCommands,
    sensitivePaths: config.classifier.sensitivePaths
  };
}

// src/version.ts
var PACKAGE_VERSION = "0.2.0";

// src/adapters/cursor/runtime-entry.ts
var RUNTIME_PACKAGE_VERSION = PACKAGE_VERSION;
var EMPTY_APPROVALS = {
  version: 1,
  approvals: []
};
function jsonResponse(value) {
  process.stdout.write(`${JSON.stringify(value)}
`);
}
async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  const raw = chunks.join("").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function findRepoRoot(startPath) {
  let current = path3.resolve(startPath);
  while (true) {
    if (existsSync(path3.join(current, ".git")) || existsSync(path3.join(current, ".cursor"))) {
      return current;
    }
    const parent = path3.dirname(current);
    if (parent === current) {
      return path3.resolve(startPath);
    }
    current = parent;
  }
}
async function loadJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function writeJsonFile(filePath, value) {
  await mkdir(path3.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}
`, "utf8");
}
async function loadConfig(repoRoot) {
  const configPath = path3.join(repoRoot, ".cursor", "belay.config.json");
  const loaded = await loadJsonFile(configPath, {});
  return {
    configPath,
    config: mergeConfig(loaded)
  };
}
function approvalsPath(repoRoot, fileName) {
  return path3.join(repoRoot, ".cursor", "belay", fileName);
}
async function loadApprovals(repoRoot, fileName) {
  const filePath = approvalsPath(repoRoot, fileName);
  const loaded = await loadJsonFile(filePath, EMPTY_APPROVALS);
  return {
    filePath,
    state: {
      version: 1,
      approvals: Array.isArray(loaded.approvals) ? loaded.approvals : []
    }
  };
}
async function appendAudit(repoRoot, config, event) {
  const auditPath = path3.join(repoRoot, config.audit.logPath);
  await mkdir(path3.dirname(auditPath), { recursive: true });
  const record = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...event };
  if (!config.audit.includeAssessment) {
    delete record.assessment;
  }
  await writeFile(auditPath, `${JSON.stringify(record)}
`, {
    encoding: "utf8",
    flag: "a"
  });
}
async function ensurePendingApproval(repoRoot, kind, result, config) {
  const pending = await loadApprovals(repoRoot, "pending-approvals.json");
  pending.state = compactApprovals(pending.state);
  const existing = pending.state.approvals.find(
    (approval2) => approval2.kind === kind && approval2.fingerprint === result.fingerprint && approval2.repoRoot === repoRoot
  );
  if (existing) {
    await writeJsonFile(pending.filePath, pending.state);
    return existing;
  }
  const approval = createApprovalRecord({
    kind,
    fingerprint: result.fingerprint,
    repoRoot,
    reason: result.reason,
    summary: result.normalizedCommand ?? result.summary ?? "",
    approvalTtlMinutes: config.approvalTtlMinutes,
    approvalId: `belay_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  });
  pending.state.approvals.push(approval);
  await writeJsonFile(pending.filePath, pending.state);
  return approval;
}
async function consumeApprovedApproval(repoRoot, kind, fingerprint) {
  const approved = await loadApprovals(repoRoot, "approved-approvals.json");
  approved.state = compactApprovals(approved.state);
  const index = approved.state.approvals.findIndex(
    (approval2) => approval2.kind === kind && approval2.fingerprint === fingerprint && approval2.repoRoot === repoRoot
  );
  if (index === -1) {
    await writeJsonFile(approved.filePath, approved.state);
    return null;
  }
  const [approval] = approved.state.approvals.splice(index, 1);
  await writeJsonFile(approved.filePath, approved.state);
  return approval;
}
async function movePendingToApproved(repoRoot, approvalId) {
  const pending = await loadApprovals(repoRoot, "pending-approvals.json");
  pending.state = compactApprovals(pending.state);
  const index = pending.state.approvals.findIndex((approval2) => approval2.approvalId === approvalId);
  if (index === -1) {
    await writeJsonFile(pending.filePath, pending.state);
    return { ok: false, message: "Belay approval not found or expired." };
  }
  const [approval] = pending.state.approvals.splice(index, 1);
  await writeJsonFile(pending.filePath, pending.state);
  const approved = await loadApprovals(repoRoot, "approved-approvals.json");
  approved.state = compactApprovals(approved.state);
  approved.state.approvals.push({
    ...approval,
    approvedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  await writeJsonFile(approved.filePath, approved.state);
  return {
    ok: true,
    message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`
  };
}
async function gateDecisionToResponse(params) {
  const { repoRoot, kind, result, config } = params;
  const approved = await consumeApprovedApproval(repoRoot, kind, result.fingerprint);
  if (approved) {
    await appendAudit(repoRoot, config, {
      event: kind === "shell" ? "beforeShellExecution" : kind === "tool" ? "preToolUse" : "subagentGate",
      kind,
      verdict: "allow",
      reason: "approved_once",
      approvalId: approved.approvalId,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? "",
      assessment: result.assessment
    });
    return { permission: "allow" };
  }
  if (result.verdict === "allow" || result.verdict === "allow_flagged") {
    await appendAudit(repoRoot, config, {
      event: kind === "shell" ? "beforeShellExecution" : kind === "tool" ? "preToolUse" : "subagentGate",
      kind,
      verdict: result.verdict,
      reason: result.reason,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? "",
      assessment: result.assessment
    });
    return { permission: "allow" };
  }
  const approval = await ensurePendingApproval(repoRoot, kind, result, config);
  await appendAudit(repoRoot, config, {
    event: kind === "shell" ? "beforeShellExecution" : kind === "tool" ? "preToolUse" : "subagentGate",
    kind,
    verdict: result.verdict,
    reason: result.reason,
    approvalId: approval.approvalId,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? "",
    assessment: result.assessment
  });
  if (config.mode === "audit") {
    return { permission: "allow" };
  }
  return {
    permission: "deny",
    user_message: `Belay blocked this high-risk action. Approval ID: ${approval.approvalId}. ${buildRetryInstruction(config.tokenPrefix, approval.approvalId)}`,
    agent_message: `Belay denied this action as ${result.reason}. Wait for approval, then retry the exact same action once.`
  };
}
async function runBeforeSubmitPromptHook() {
  try {
    const payload = await readStdinJson();
    const prompt = String(payload.prompt ?? "");
    const repoRoot = findRepoRoot(process.cwd());
    const { config } = await loadConfig(repoRoot);
    const approvalId = approvalCommandMatch(prompt, config.tokenPrefix);
    if (!approvalId) {
      jsonResponse({ continue: true });
      return;
    }
    const moved = await movePendingToApproved(repoRoot, approvalId);
    await appendAudit(repoRoot, config, {
      event: "beforeSubmitPrompt",
      kind: "approval",
      verdict: moved.ok ? "allow" : "deny_pending_approval",
      approvalId,
      reason: moved.ok ? "approval_recorded" : "approval_missing",
      summary: prompt
    });
    jsonResponse({
      continue: false,
      user_message: moved.message
    });
  } catch {
    jsonResponse({
      continue: false,
      user_message: "agent-belay failed while processing approval state. Run agent-belay doctor, then retry."
    });
  }
}
async function runShellGateHook() {
  try {
    const payload = await readStdinJson();
    const command = String(payload.command ?? "").trim();
    const cwd = String(payload.cwd ?? process.cwd()).trim() || process.cwd();
    const repoRoot = findRepoRoot(cwd);
    const { config } = await loadConfig(repoRoot);
    if (!config.gates.shell) {
      jsonResponse({ permission: "allow" });
      return;
    }
    const options = classifierOptionsFromConfig(config);
    const result = classifyShell(command, cwd, repoRoot, options);
    const response = await gateDecisionToResponse({
      repoRoot,
      kind: "shell",
      result,
      config
    });
    jsonResponse(response);
  } catch {
    jsonResponse({
      permission: "deny",
      user_message: "agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry."
    });
  }
}
function isSubagentEvent(payload, eventName) {
  return eventName === "subagentStart" || payload.subagent_type !== void 0;
}
function isFileMutationTool(toolName) {
  return toolName === "Write" || toolName === "StrReplace" || toolName === "Delete";
}
async function runToolGateHook(eventName) {
  try {
    const payload = await readStdinJson();
    const cwd = process.cwd();
    const repoRoot = findRepoRoot(cwd);
    const { config } = await loadConfig(repoRoot);
    const options = classifierOptionsFromConfig(config);
    const toolName = String(payload.tool_name ?? "");
    if (isSubagentEvent(payload, eventName)) {
      if (!config.gates.subagent) {
        jsonResponse({ permission: "allow" });
        return;
      }
      const result = classifySubagent(payload, repoRoot, options);
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: "subagent",
        result,
        config
      });
      jsonResponse(response);
      return;
    }
    if (toolName === "Shell") {
      if (!config.gates.toolShell) {
        jsonResponse({ permission: "allow" });
        return;
      }
      const result = classifyToolUse(payload, repoRoot, cwd, options);
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: "tool",
        result,
        config
      });
      jsonResponse(response);
      return;
    }
    if (isFileMutationTool(toolName)) {
      if (!config.gates.fileMutation) {
        jsonResponse({ permission: "allow" });
        return;
      }
      const result = classifyToolUse(payload, repoRoot, cwd, options);
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: "tool",
        result,
        config
      });
      jsonResponse(response);
      return;
    }
    if (payload.tool_name === "Task") {
      if (!config.gates.subagent) {
        jsonResponse({ permission: "allow" });
        return;
      }
      const result = classifySubagent(payload, repoRoot, options);
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: "subagent",
        result,
        config
      });
      jsonResponse(response);
      return;
    }
    jsonResponse({ permission: "allow" });
  } catch {
    jsonResponse({
      permission: "deny",
      user_message: "agent-belay failed while classifying this tool action. Run agent-belay doctor, then retry."
    });
  }
}
async function runAuditHook(eventName) {
  try {
    const payload = await readStdinJson();
    const repoRoot = findRepoRoot(process.cwd());
    const { config } = await loadConfig(repoRoot);
    await appendAudit(repoRoot, config, {
      event: eventName,
      kind: "audit",
      verdict: "allow",
      reason: "observed",
      summary: canonicalStringify(scrubValue(payload))
    });
    jsonResponse({});
  } catch (error) {
    console.error(
      "agent-belay audit hook failed:",
      error instanceof Error ? error.message : String(error)
    );
    jsonResponse({});
  }
}
export {
  RUNTIME_PACKAGE_VERSION,
  runAuditHook,
  runBeforeSubmitPromptHook,
  runShellGateHook,
  runToolGateHook
};
