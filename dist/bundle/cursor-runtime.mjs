// agent-belay cursor runtime bundle

// src/adapters/cursor/runtime-entry.ts
import process2 from "node:process";

// src/adapters/layouts/cursor.ts
import path2 from "node:path";

// src/core/config.ts
import path from "node:path";
var LEGACY_POLICY_V3 = {
  unknownLocalEffect: "allow_flagged",
  unparseableShell: "allow_flagged"
};
var DEFAULT_POLICY_V3 = {
  unknownLocalEffect: "deny",
  unparseableShell: "deny"
};
var DEFAULT_OVERRIDES_V3 = {
  allow: [],
  external: []
};
var DEFAULT_REDACTION_V3 = {
  maskApprovalIds: true,
  maskBearerTokens: true,
  maskAuthHeaders: true,
  maskKeyValueSecrets: true,
  maskHighEntropyStrings: false
};
var LEGACY_CONTROL_PLANE_V3 = {
  enabled: false,
  configDir: null,
  integrity: "none",
  spikeOnPrompt: false
};
var DEFAULT_CONTROL_PLANE_V3 = {
  enabled: true,
  configDir: null,
  integrity: "hash-pinned",
  spikeOnPrompt: false
};
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
    logPath: "belay/audit.ndjson",
    includeAssessment: true
  }
};
var DEFAULT_CONFIG_V3 = {
  version: 3,
  mode: DEFAULT_CONFIG_V2.mode,
  approvalTtlMinutes: DEFAULT_CONFIG_V2.approvalTtlMinutes,
  tokenPrefix: DEFAULT_CONFIG_V2.tokenPrefix,
  gates: { ...DEFAULT_CONFIG_V2.gates },
  classifier: {
    strictChains: DEFAULT_CONFIG_V2.classifier.strictChains,
    sensitivePaths: [...DEFAULT_CONFIG_V2.classifier.sensitivePaths]
  },
  policy: { ...DEFAULT_POLICY_V3 },
  overrides: { ...DEFAULT_OVERRIDES_V3 },
  redaction: { ...DEFAULT_REDACTION_V3 },
  controlPlane: { ...DEFAULT_CONTROL_PLANE_V3 },
  audit: { ...DEFAULT_CONFIG_V2.audit }
};
function uniqueStrings(values) {
  return [...new Set(values)];
}
function mergeOverrideLists(primary, secondary) {
  return uniqueStrings([...primary, ...secondary]);
}
function mapLegacyClassifierToOverrides(classifier) {
  return {
    allow: Array.isArray(classifier.customAllowCommands) ? classifier.customAllowCommands : [],
    external: Array.isArray(classifier.customExternalCommands) ? classifier.customExternalCommands : []
  };
}
function migrateV2ToV3(v2, rawOverrides) {
  const legacyOverrides = mapLegacyClassifierToOverrides(v2.classifier);
  return normalizeConfig({
    version: 3,
    mode: v2.mode,
    approvalTtlMinutes: v2.approvalTtlMinutes,
    tokenPrefix: v2.tokenPrefix,
    gates: v2.gates,
    classifier: {
      strictChains: v2.classifier.strictChains,
      sensitivePaths: v2.classifier.sensitivePaths
    },
    policy: { ...LEGACY_POLICY_V3 },
    overrides: {
      allow: mergeOverrideLists(rawOverrides?.allow ?? [], legacyOverrides.allow),
      external: mergeOverrideLists(rawOverrides?.external ?? [], legacyOverrides.external)
    },
    redaction: { ...DEFAULT_REDACTION_V3 },
    controlPlane: { ...LEGACY_CONTROL_PLANE_V3 },
    audit: v2.audit
  });
}
function hasV3Sections(raw) {
  return raw.policy !== void 0 || raw.overrides !== void 0 || raw.redaction !== void 0 || raw.controlPlane !== void 0;
}
function looksLikeV2Config(raw) {
  return raw.gates?.fileMutation !== void 0 || raw.gates?.toolShell !== void 0 || raw.classifier?.customAllowCommands !== void 0 || raw.classifier?.customExternalCommands !== void 0 || raw.audit?.includeAssessment !== void 0;
}
function mergeV3FromRaw(base, raw) {
  return normalizeConfig({
    ...base,
    policy: {
      ...base.policy,
      ...raw.policy ?? {}
    },
    overrides: {
      allow: mergeOverrideLists(base.overrides.allow, raw.overrides?.allow ?? []),
      external: mergeOverrideLists(base.overrides.external, raw.overrides?.external ?? [])
    },
    redaction: {
      ...base.redaction,
      ...raw.redaction ?? {}
    },
    controlPlane: {
      ...base.controlPlane,
      ...raw.controlPlane ?? {}
    }
  });
}
function normalizeV3Raw(raw) {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V3,
    ...raw,
    version: 3,
    gates: {
      ...DEFAULT_CONFIG_V3.gates,
      ...raw.gates ?? {}
    },
    classifier: {
      ...DEFAULT_CONFIG_V3.classifier,
      ...raw.classifier ?? {}
    },
    policy: {
      unknownLocalEffect: raw.policy?.unknownLocalEffect ?? LEGACY_POLICY_V3.unknownLocalEffect,
      unparseableShell: raw.policy?.unparseableShell ?? LEGACY_POLICY_V3.unparseableShell
    },
    overrides: {
      ...DEFAULT_CONFIG_V3.overrides,
      ...raw.overrides ?? {}
    },
    redaction: {
      ...DEFAULT_CONFIG_V3.redaction,
      ...raw.redaction ?? {}
    },
    controlPlane: {
      enabled: raw.controlPlane?.enabled ?? LEGACY_CONTROL_PLANE_V3.enabled,
      configDir: raw.controlPlane?.configDir ?? LEGACY_CONTROL_PLANE_V3.configDir,
      integrity: raw.controlPlane?.integrity ?? LEGACY_CONTROL_PLANE_V3.integrity,
      spikeOnPrompt: raw.controlPlane?.spikeOnPrompt ?? LEGACY_CONTROL_PLANE_V3.spikeOnPrompt
    },
    audit: {
      ...DEFAULT_CONFIG_V3.audit,
      ...raw.audit ?? {}
    }
  });
}
function migrateConfig(loaded) {
  if (typeof loaded !== "object" || loaded === null) {
    return { ...DEFAULT_CONFIG_V3 };
  }
  const raw = loaded;
  if (raw.version === 3 || raw.version === void 0 && hasV3Sections(raw)) {
    return normalizeV3Raw(raw);
  }
  const baseV2 = { ...DEFAULT_CONFIG_V2 };
  if (raw.version === 1 || raw.version === void 0 && !looksLikeV2Config(raw)) {
    const migratedV22 = normalizeConfigV2({
      ...baseV2,
      mode: raw.mode ?? baseV2.mode,
      approvalTtlMinutes: raw.approvalTtlMinutes ?? baseV2.approvalTtlMinutes,
      tokenPrefix: raw.tokenPrefix ?? baseV2.tokenPrefix,
      gates: {
        ...baseV2.gates,
        shell: raw.gates?.shell ?? baseV2.gates.shell,
        subagent: raw.gates?.subagent ?? baseV2.gates.subagent
      },
      audit: {
        ...baseV2.audit,
        logPath: raw.audit?.logPath ?? baseV2.audit.logPath
      }
    });
    return mergeV3FromRaw(migrateV2ToV3(migratedV22, raw.overrides), raw);
  }
  const migratedV2 = normalizeConfigV2({
    ...baseV2,
    ...raw,
    version: 2,
    gates: {
      ...baseV2.gates,
      ...raw.gates ?? {}
    },
    classifier: {
      ...baseV2.classifier,
      ...raw.classifier ?? {}
    },
    audit: {
      ...baseV2.audit,
      ...raw.audit ?? {}
    }
  });
  return mergeV3FromRaw(migrateV2ToV3(migratedV2, raw.overrides), raw);
}
function normalizeConfigV2(config) {
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
function normalizeConfig(config) {
  if (config.version === 2) {
    return normalizeConfigV2(config);
  }
  const v3 = config;
  return {
    version: 3,
    mode: v3.mode === "audit" ? "audit" : "enforce",
    approvalTtlMinutes: typeof v3.approvalTtlMinutes === "number" && v3.approvalTtlMinutes > 0 ? v3.approvalTtlMinutes : DEFAULT_CONFIG_V3.approvalTtlMinutes,
    tokenPrefix: v3.tokenPrefix || DEFAULT_CONFIG_V3.tokenPrefix,
    gates: {
      shell: v3.gates.shell !== false,
      subagent: v3.gates.subagent !== false,
      fileMutation: v3.gates.fileMutation !== false,
      toolShell: v3.gates.toolShell !== false
    },
    classifier: {
      strictChains: v3.classifier?.strictChains !== false,
      sensitivePaths: Array.isArray(v3.classifier?.sensitivePaths) ? v3.classifier.sensitivePaths : DEFAULT_CONFIG_V3.classifier.sensitivePaths
    },
    policy: {
      unknownLocalEffect: v3.policy?.unknownLocalEffect === "deny" ? "deny" : v3.policy?.unknownLocalEffect === "allow_flagged" ? "allow_flagged" : DEFAULT_POLICY_V3.unknownLocalEffect,
      unparseableShell: v3.policy?.unparseableShell === "deny" ? "deny" : v3.policy?.unparseableShell === "allow_flagged" ? "allow_flagged" : DEFAULT_POLICY_V3.unparseableShell
    },
    overrides: {
      allow: Array.isArray(v3.overrides?.allow) ? uniqueStrings(v3.overrides.allow) : [],
      external: Array.isArray(v3.overrides?.external) ? uniqueStrings(v3.overrides.external) : []
    },
    redaction: {
      maskApprovalIds: v3.redaction?.maskApprovalIds !== false,
      maskBearerTokens: v3.redaction?.maskBearerTokens !== false,
      maskAuthHeaders: v3.redaction?.maskAuthHeaders !== false,
      maskKeyValueSecrets: v3.redaction?.maskKeyValueSecrets !== false,
      maskHighEntropyStrings: v3.redaction?.maskHighEntropyStrings === true
    },
    controlPlane: {
      enabled: v3.controlPlane?.enabled === true ? true : v3.controlPlane?.enabled === false ? false : DEFAULT_CONTROL_PLANE_V3.enabled,
      configDir: typeof v3.controlPlane?.configDir === "string" && v3.controlPlane.configDir.trim() ? v3.controlPlane.configDir.trim() : null,
      integrity: v3.controlPlane?.integrity === "hash-pinned" ? "hash-pinned" : v3.controlPlane?.integrity === "none" ? "none" : DEFAULT_CONTROL_PLANE_V3.integrity,
      spikeOnPrompt: v3.controlPlane?.spikeOnPrompt === true
    },
    audit: {
      logPath: v3.audit?.logPath || DEFAULT_CONFIG_V3.audit.logPath,
      includeAssessment: v3.audit?.includeAssessment !== false
    }
  };
}
function isFreshConfigInput(loaded) {
  if (loaded === null || loaded === void 0) {
    return true;
  }
  if (typeof loaded !== "object") {
    return true;
  }
  return Object.keys(loaded).length === 0;
}
function mergeConfig(existing, defaults = DEFAULT_CONFIG_V3) {
  const migrated = isFreshConfigInput(existing) ? normalizeConfig({ ...defaults, version: 3 }) : migrateConfig(existing);
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
    policy: {
      ...defaults.policy,
      ...migrated.policy
    },
    overrides: {
      allow: mergeOverrideLists(defaults.overrides.allow, migrated.overrides.allow),
      external: mergeOverrideLists(defaults.overrides.external, migrated.overrides.external)
    },
    redaction: {
      ...defaults.redaction,
      ...migrated.redaction
    },
    controlPlane: {
      ...defaults.controlPlane,
      ...migrated.controlPlane
    },
    audit: {
      ...defaults.audit,
      ...migrated.audit
    }
  });
}
function scrubOptionsFromConfig(config) {
  return { ...config.redaction };
}
function classifierOptionsFromConfig(config) {
  return {
    strictChains: config.classifier.strictChains,
    customExternalCommands: config.overrides.external,
    customAllowCommands: config.overrides.allow,
    sensitivePaths: config.classifier.sensitivePaths,
    unknownLocalEffect: config.policy.unknownLocalEffect,
    unparseableShell: config.policy.unparseableShell,
    controlPlaneDir: config.controlPlane.enabled ? resolveControlPlaneDir(config) : null,
    scrubOptions: scrubOptionsFromConfig(config)
  };
}
function defaultControlPlaneDir(env = process.env, homedir = () => env.HOME ?? env.USERPROFILE ?? "") {
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "agent-belay");
    }
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const base = xdgConfigHome || path.join(homedir(), ".config");
  return path.join(base, "agent-belay");
}
function resolveControlPlaneDir(config) {
  if (config.controlPlane.configDir) {
    return config.controlPlane.configDir;
  }
  return defaultControlPlaneDir();
}
function belayStateDir(config, repoLocalStateDir) {
  if (config.controlPlane.enabled) {
    return resolveControlPlaneDir(config);
  }
  return repoLocalStateDir;
}
function pendingApprovalsFile(config, repoLocalStateDir) {
  return path.join(belayStateDir(config, repoLocalStateDir), "pending-approvals.json");
}
function approvedApprovalsFile(config, repoLocalStateDir) {
  return path.join(belayStateDir(config, repoLocalStateDir), "approved-approvals.json");
}

// src/adapters/layouts/cursor.ts
function runnerCommand(platform, hookName, ...args) {
  const base = platform === "win32" ? ".\\.cursor\\hooks\\belay-runner.cmd" : "./.cursor/hooks/belay-runner";
  return [base, hookName, ...args].join(" ");
}
var cursorLayout = {
  name: "cursor",
  configPath(repoRoot) {
    return path2.join(repoRoot, ".cursor", "belay.config.json");
  },
  hooksSettingsPath(repoRoot) {
    return path2.join(repoRoot, ".cursor", "hooks.json");
  },
  hooksDir(repoRoot) {
    return path2.join(repoRoot, ".cursor", "hooks");
  },
  runtimeDir(repoRoot) {
    return path2.join(repoRoot, ".cursor", "belay", "runtime");
  },
  repoLocalStateDir(repoRoot) {
    return path2.join(repoRoot, ".cursor", "belay");
  },
  defaultAuditLogPath(_repoRoot) {
    return path2.join(".cursor", "belay", "audit.ndjson");
  },
  repoRootMarkers: [".git", ".cursor"],
  runnerCommand,
  defaultConfig(repoRoot) {
    return {
      ...DEFAULT_CONFIG_V3,
      adapter: "cursor",
      audit: {
        ...DEFAULT_CONFIG_V3.audit,
        logPath: cursorLayout.defaultAuditLogPath(repoRoot)
      }
    };
  }
};

// src/adapters/shared/gate-runtime.ts
import { randomUUID } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import path6 from "node:path";

// src/core/gate-contract.ts
var GATE_CONTRACT_VERSION = 1;
function classifyResultToGateVerdict(params) {
  const { result, mode, permission, wouldBlock, approvalId, user_message, agent_message } = params;
  return {
    contractVersion: GATE_CONTRACT_VERSION,
    verdict: result.verdict,
    reason: result.reason,
    fingerprint: result.fingerprint,
    assessment: result.assessment,
    normalizedCommand: result.normalizedCommand,
    summary: result.summary,
    permission,
    wouldBlock,
    mode,
    approvalId,
    user_message,
    agent_message
  };
}
function unnormalizedGateVerdict(params) {
  return {
    contractVersion: GATE_CONTRACT_VERSION,
    verdict: "deny_pending_approval",
    reason: params.reason,
    fingerprint: "unnormalized",
    assessment: {
      reversibility: "irreversible",
      external: true,
      blastRadius: "unknown",
      confidence: 0,
      signals: ["normalization_failed"]
    },
    permission: "deny",
    wouldBlock: true,
    mode: params.mode,
    user_message: params.user_message,
    agent_message: params.agent_message
  };
}

// src/core/custom-command-match.ts
function matchesCustomCommand(normalizedCommand, key, pattern) {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  return normalizedCommand === trimmed || key === trimmed;
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
import { realpathSync } from "node:fs";
import path3 from "node:path";
function resolveRealpath(targetPath) {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path3.resolve(targetPath);
  }
}
function pathWithinRoot(root, targetPath) {
  const resolvedRoot = resolveRealpath(root);
  const resolvedTarget = resolveRealpath(targetPath);
  const relativePath = path3.relative(resolvedRoot, resolvedTarget);
  if (relativePath === "") {
    return true;
  }
  return !relativePath.startsWith("..") && !path3.isAbsolute(relativePath);
}
function relativeWithinRepo(repoRoot, targetPath) {
  const resolvedRoot = resolveRealpath(repoRoot);
  const resolvedTarget = resolveRealpath(targetPath);
  const relativePath = path3.relative(resolvedRoot, resolvedTarget);
  if (relativePath === "") {
    return ".";
  }
  if (relativePath.startsWith("..")) {
    return null;
  }
  return relativePath;
}
function normalizeToken(token, repoRoot) {
  if (!path3.isAbsolute(token)) {
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
  if (path3.isAbsolute(token)) {
    return resolveRealpath(token);
  }
  if (token.startsWith("./") || token.startsWith("../")) {
    return resolveRealpath(path3.resolve(cwd, token));
  }
  if (!token.includes("/") && !token.includes("\\")) {
    return resolveRealpath(path3.resolve(cwd, token));
  }
  return resolveRealpath(path3.resolve(cwd, token));
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

// src/core/shell-substitution.ts
var MAX_SUBSTITUTION_DEPTH = 8;
function findCommandSubstitutions(command) {
  const results = [];
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  while (index < command.length) {
    const char = command[index];
    if (escaping) {
      escaping = false;
      index += 1;
      continue;
    }
    if (char === "\\" && (inSingle || inDouble)) {
      escaping = true;
      index += 1;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      index += 1;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      index += 1;
      continue;
    }
    if (inSingle || inDouble) {
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 2;
      continue;
    }
    if (char === "`") {
      const end = findClosingBacktick(command, index + 1);
      if (end === -1) {
        break;
      }
      const inner = command.slice(index + 1, end).trim();
      if (inner) {
        results.push(inner);
      }
      index = end + 1;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      const closed = extractBalancedParenContent(command, index + 2);
      if (!closed) {
        index += 1;
        continue;
      }
      const inner = closed.content.trim();
      if (inner) {
        results.push(inner);
      }
      index = closed.endIndex;
      continue;
    }
    index += 1;
  }
  return results;
}
function findClosingBacktick(command, start) {
  let index = start;
  while (index < command.length) {
    if (command[index] === "\\" && index + 1 < command.length) {
      index += 2;
      continue;
    }
    if (command[index] === "`") {
      return index;
    }
    index += 1;
  }
  return -1;
}
function extractBalancedParenContent(command, start) {
  let depth = 1;
  let index = start;
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  while (index < command.length && depth > 0) {
    const char = command[index];
    if (escaping) {
      escaping = false;
      index += 1;
      continue;
    }
    if (char === "\\" && (inSingle || inDouble)) {
      escaping = true;
      index += 1;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      index += 1;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      index += 1;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          return {
            content: command.slice(start, index),
            endIndex: index + 1
          };
        }
      }
    }
    index += 1;
  }
  return null;
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
  "pwd",
  "rg",
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
var DYNAMIC_SHELL_COMMANDS = /* @__PURE__ */ new Set(["eval", "source", "exec"]);
var INTERPRETER_SCRIPT_FLAGS = /* @__PURE__ */ new Set(["-c", "-lc", "-e", "--eval"]);
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
function isExternalKey(key, normalizedCommand, options) {
  return EXTERNAL_COMMANDS.has(key) || (options.customExternalCommands ?? []).some(
    (pattern) => matchesCustomCommand(normalizedCommand, key, pattern)
  );
}
function matchesCustomAllow(normalizedCommand, key, options) {
  return (options.customAllowCommands ?? []).some(
    (pattern) => matchesCustomCommand(normalizedCommand, key, pattern)
  );
}
function matchesCustomExternal(normalizedCommand, key, options) {
  return (options.customExternalCommands ?? []).some(
    (pattern) => matchesCustomCommand(normalizedCommand, key, pattern)
  );
}
function targetsControlPlane(paths, cwd, controlPlaneDir) {
  if (!controlPlaneDir) {
    return false;
  }
  return paths.some((target) => {
    const resolved = resolveMutationTarget(target, cwd);
    if (!resolved) {
      return false;
    }
    return pathWithinRoot(controlPlaneDir, resolved);
  });
}
function classifySubstitutionInners(params) {
  const { command, cwd, repoRoot, options, depth } = params;
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    return null;
  }
  const substitutions = findCommandSubstitutions(command);
  if (substitutions.length === 0) {
    return null;
  }
  const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken);
  const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd;
  let worst = null;
  for (const substitution of substitutions) {
    const inner = classifyShell(substitution, cwd, repoRoot, options, depth + 1);
    if (options.unknownLocalEffect === "deny") {
      return denyResult({
        reason: "command_substitution",
        normalizedCommand,
        cwdRelative,
        assessment: {
          reversibility: "irreversible",
          external: inner.assessment.external,
          blastRadius: "command substitution",
          confidence: 0.9,
          signals: ["command_substitution", ...inner.assessment.signals]
        }
      });
    }
    const wrapped = wrapInnerVerdict({
      inner,
      normalizedCommand,
      cwdRelative,
      wrapReason: "command_substitution",
      wrapSignal: "command_substitution"
    });
    worst = worst ? worseVerdict(worst, wrapped) : wrapped;
  }
  return worst;
}
function unknownLocalEffectResult(params) {
  const { normalizedCommand, cwdRelative, assessment, options } = params;
  if (options.unknownLocalEffect === "deny") {
    return denyResult({
      reason: "unknown_local_effect",
      normalizedCommand,
      cwdRelative,
      assessment
    });
  }
  return {
    verdict: "allow_flagged",
    reason: "unknown_local_effect",
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
    assessment
  };
}
function extractInterpreterScript(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (INTERPRETER_SCRIPT_FLAGS.has(flag)) {
      return tokens[index + 1] ?? null;
    }
  }
  return null;
}
function hasInPlaceSedFlag(tokens) {
  return tokens.some((token) => token === "-i" || token === "--in-place");
}
function wrapInnerVerdict(params) {
  const { inner, normalizedCommand, cwdRelative, wrapReason, wrapSignal } = params;
  const signals = [wrapSignal, ...inner.assessment.signals];
  if (inner.verdict === "deny_pending_approval") {
    return {
      ...inner,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      reason: wrapReason,
      assessment: {
        ...inner.assessment,
        signals
      }
    };
  }
  if (inner.verdict === "allow_flagged") {
    return {
      ...inner,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      reason: wrapReason,
      assessment: {
        ...inner.assessment,
        signals
      }
    };
  }
  if (inner.verdict === "allow") {
    return {
      verdict: "allow_flagged",
      reason: wrapReason,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: "recoverable_with_cost",
        external: inner.assessment.external,
        blastRadius: inner.assessment.blastRadius,
        confidence: Math.min(inner.assessment.confidence, 0.7),
        signals
      }
    };
  }
  return inner;
}
function classifySegment(segment, cwd, repoRoot, normalizedCommand, cwdRelative, options, depth) {
  const segmentTokens = segment.tokens;
  const key = commandKey(segmentTokens);
  const redirects = extractRedirectTargets(segmentTokens);
  const signals = [];
  if (matchesCustomAllow(normalizedCommand, key, options)) {
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
  if (matchesCustomExternal(normalizedCommand, key, options)) {
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
  if (DYNAMIC_SHELL_COMMANDS.has(key) || key === "." && segmentTokens.length > 1) {
    signals.push("dynamic_shell_evaluation");
    return denyResult({
      reason: "dynamic_shell_evaluation",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: true,
        blastRadius: "dynamic shell evaluation",
        confidence: 0.93,
        signals
      }
    });
  }
  if (targetsControlPlane(redirects, cwd, options.controlPlaneDir)) {
    signals.push("control_plane_redirect");
    return denyResult({
      reason: "control_plane_mutation",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: false,
        blastRadius: "agent-belay control plane",
        confidence: 0.97,
        signals
      }
    });
  }
  if (targetsControlPlane(segmentTokens.slice(1), cwd, options.controlPlaneDir)) {
    signals.push("control_plane_path");
    return denyResult({
      reason: "control_plane_mutation",
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: "irreversible",
        external: false,
        blastRadius: "agent-belay control plane",
        confidence: 0.97,
        signals
      }
    });
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
  if (depth < 2) {
    const innerScript = extractInterpreterScript(segmentTokens);
    if (innerScript && (SHELL_INTERPRETERS.has(key) || key === "node")) {
      const inner = classifyShell(innerScript, cwd, repoRoot, options, depth + 1);
      const wrapReason = key === "node" ? "node_eval" : "shell_interpreter_script";
      const wrapSignal = key === "node" ? "node_eval" : "shell_interpreter_script";
      return wrapInnerVerdict({
        inner,
        normalizedCommand,
        cwdRelative,
        wrapReason,
        wrapSignal
      });
    }
  }
  if (key === "sed" && hasInPlaceSedFlag(segmentTokens)) {
    signals.push("sed_in_place");
    return {
      verdict: "allow_flagged",
      reason: "local_mutation",
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: "recoverable_with_cost",
        external: false,
        blastRadius: "this repository",
        confidence: 0.74,
        signals
      }
    };
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
  if (isExternalKey(key, normalizedCommand, options)) {
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
  if (key === "node" || key === "sed") {
    signals.push(key === "node" ? "node_execution" : "sed_execution");
    return unknownLocalEffectResult({
      normalizedCommand,
      cwdRelative,
      options,
      assessment: {
        reversibility: "recoverable_with_cost",
        external: false,
        blastRadius: "this repository",
        confidence: 0.64,
        signals
      }
    });
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
  return unknownLocalEffectResult({
    normalizedCommand,
    cwdRelative,
    options,
    assessment: {
      reversibility: "recoverable_with_cost",
      external: false,
      blastRadius: "this repository",
      confidence: 0.61,
      signals
    }
  });
}
function classifyShell(command, cwd, repoRoot, options = {}, depth = 0) {
  const substitutionResult = classifySubstitutionInners({
    command,
    cwd,
    repoRoot,
    options,
    depth
  });
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
      options,
      depth
    );
    effective = worseVerdict(effective, result);
    if (result.verdict === "deny_pending_approval" && options.strictChains !== true) {
      break;
    }
  }
  if (substitutionResult) {
    effective = worseVerdict(effective, substitutionResult);
  }
  return effective;
}

// src/core/scrub.ts
var UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
var TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
var APPROVAL_ID_PATTERN = /\bbelay_[a-z0-9]{8,}\b/gi;
var TOKEN_PREFIX_PATTERN = /\/belay-approve\s+\S+/gi;
var BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
var AUTH_HEADER_PATTERN = /\bAuthorization:\s*\S+/gi;
var KEY_VALUE_SECRET_PATTERN = /\b(api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]\s*['"]?[^\s'"]{4,}/gi;
var HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
var DEFAULT_SCRUB_OPTIONS = {
  maskApprovalIds: true,
  maskBearerTokens: true,
  maskAuthHeaders: true,
  maskKeyValueSecrets: true,
  maskHighEntropyStrings: false
};
function resolvedScrubOptions(options = {}) {
  return {
    maskApprovalIds: options.maskApprovalIds !== false,
    maskBearerTokens: options.maskBearerTokens !== false,
    maskAuthHeaders: options.maskAuthHeaders !== false,
    maskKeyValueSecrets: options.maskKeyValueSecrets !== false,
    maskHighEntropyStrings: options.maskHighEntropyStrings === true
  };
}
function scrubString(value, options = {}) {
  const resolved = resolvedScrubOptions(options);
  let scrubbed = value.replace(UUID_PATTERN, "<uuid>").replace(TIMESTAMP_PATTERN, "<timestamp>");
  if (resolved.maskApprovalIds) {
    scrubbed = scrubbed.replace(APPROVAL_ID_PATTERN, "<approval-id>").replace(TOKEN_PREFIX_PATTERN, "/belay-approve <approval-id>");
  }
  if (resolved.maskBearerTokens) {
    scrubbed = scrubbed.replace(BEARER_PATTERN, "Bearer <redacted>");
  }
  if (resolved.maskAuthHeaders) {
    scrubbed = scrubbed.replace(AUTH_HEADER_PATTERN, "Authorization: <redacted>");
  }
  if (resolved.maskKeyValueSecrets) {
    scrubbed = scrubbed.replace(KEY_VALUE_SECRET_PATTERN, (match) => {
      const separatorIndex = Math.max(match.indexOf("="), match.indexOf(":"));
      if (separatorIndex === -1) {
        return "<secret>";
      }
      return `${match.slice(0, separatorIndex + 1)}<redacted>`;
    });
  }
  if (resolved.maskHighEntropyStrings) {
    scrubbed = scrubbed.replace(HIGH_ENTROPY_PATTERN, "<high-entropy>");
  }
  return scrubbed;
}
function scrubValue(value, options = DEFAULT_SCRUB_OPTIONS) {
  if (typeof value === "string") {
    return scrubString(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, options));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = scrubValue(child, options);
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
function extractSubagentText(payload, options) {
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
  return canonicalStringify(scrubValue(payload, options.scrubOptions));
}
function fingerprintSource(payload, options) {
  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const input = toolInput;
    return scrubValue(
      {
        description: input.description ?? "",
        prompt: input.prompt ?? ""
      },
      options.scrubOptions
    );
  }
  const task = payload.task;
  if (typeof task === "string") {
    return scrubValue({ task }, options.scrubOptions);
  }
  if (task && typeof task === "object") {
    const taskObj = task;
    return scrubValue(
      {
        description: taskObj.description ?? "",
        prompt: taskObj.prompt ?? ""
      },
      options.scrubOptions
    );
  }
  return scrubValue(payload, options.scrubOptions);
}
function classifySubagent(payload, repoRoot, options = {}) {
  const kind = payload.tool_name === "Task" ? "Task" : String(payload.subagent_type ?? "generalPurpose");
  const scrubbed = fingerprintSource(payload, options);
  const summary = extractSubagentText(payload, options);
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
import path4 from "node:path";

// src/core/glob.ts
function matchesSensitivePath(filePath, patterns) {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const baseName = segments.at(-1) ?? normalized;
  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll("\\", "/");
    if (normalizedPattern.includes("**")) {
      const parts = normalizedPattern.split("**").map((part) => part.replace(/^\/+|\/+$/g, ""));
      const prefix = parts[0]?.replace(/\/+$/, "") ?? "";
      const suffix = parts[1]?.replace(/^\/+/, "") ?? "";
      if (prefix && !normalized.startsWith(prefix)) {
        continue;
      }
      if (suffix && !normalized.includes(suffix)) {
        continue;
      }
      if (prefix || suffix) {
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
      continue;
    }
    if (normalized === normalizedPattern || baseName === normalizedPattern) {
      return true;
    }
    if (normalized.endsWith(`/${normalizedPattern}`)) {
      return true;
    }
    if (segments.includes(normalizedPattern)) {
      return true;
    }
  }
  return false;
}

// src/core/classify-tool.ts
var DEFAULT_SENSITIVE_PATHS = [".env", ".env.*", "**/credentials/**"];
function scrubPayload(value, options) {
  return scrubValue(value, options.scrubOptions);
}
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
        summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
        fingerprint: toolFingerprint(
          toolName,
          scrubPayload(payload.tool_input ?? {}, options),
          repoRoot
        ),
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
      summary: command
    };
  }
  if (toolName === "Write" || toolName === "StrReplace" || toolName === "Delete") {
    const filePath = extractFilePath(payload);
    if (!filePath) {
      return {
        verdict: "allow_flagged",
        reason: "file_mutation_missing_path",
        summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
        fingerprint: toolFingerprint(
          toolName,
          scrubPayload(payload.tool_input ?? {}, options),
          repoRoot
        ),
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
    const resolvedPath = path4.isAbsolute(filePath) ? filePath : path4.resolve(cwd, filePath);
    if (options.controlPlaneDir && pathWithinRoot(options.controlPlaneDir, resolvedPath)) {
      signals.push("control_plane_path");
      return {
        verdict: "deny_pending_approval",
        reason: "control_plane_mutation",
        summary: filePath,
        fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
        assessment: {
          reversibility: "irreversible",
          external: false,
          blastRadius: "agent-belay control plane",
          confidence: 0.97,
          signals
        }
      };
    }
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
    summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
    fingerprint: toolFingerprint(
      toolName,
      scrubPayload(payload.tool_input ?? {}, options),
      repoRoot
    ),
    assessment: {
      reversibility: "reversible",
      external: false,
      blastRadius: "tool scope",
      confidence: 0.5,
      signals: ["unclassified_tool"]
    }
  };
}

// src/core/gate-engine.ts
var GateNormalizationError = class extends Error {
  reason = "normalization_failed";
  constructor(message) {
    super(message);
    this.name = "GateNormalizationError";
  }
};
function shellCommandFromPayload(payload) {
  const direct = payload.command;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const command = toolInput.command;
    if (typeof command === "string" && command.trim()) {
      return command.trim();
    }
  }
  return "";
}
function normalizeGatedAction(params) {
  const { kind, repoRoot, cwd, payload, toolName, agentAssessment } = params;
  let command = params.command?.trim() ?? "";
  if (kind === "shell" && !command && payload) {
    command = shellCommandFromPayload(payload);
  }
  if (kind === "shell" && !command) {
    throw new GateNormalizationError("Shell gated action requires a command.");
  }
  if (kind === "tool" && !payload) {
    throw new GateNormalizationError("Tool gated action requires a payload.");
  }
  if (kind === "subagent" && !payload) {
    throw new GateNormalizationError("Subagent gated action requires a payload.");
  }
  return {
    contractVersion: GATE_CONTRACT_VERSION,
    kind,
    repoRoot,
    cwd,
    command: command || void 0,
    payload,
    toolName,
    agentAssessment
  };
}
function classifyGatedAction(action, config) {
  const options = classifierOptionsFromConfig(config);
  if (action.kind === "shell") {
    const command = action.command ?? shellCommandFromPayload(action.payload ?? {});
    if (!command) {
      throw new GateNormalizationError("Shell gated action requires a command.");
    }
    return classifyShell(command, action.cwd, action.repoRoot, options);
  }
  if (action.kind === "subagent") {
    return classifySubagent(action.payload ?? {}, action.repoRoot, options);
  }
  return classifyToolUse(action.payload ?? {}, action.repoRoot, action.cwd, options);
}
function gateEnabledForAction(config, action) {
  if (action.kind === "shell") {
    return config.gates.shell;
  }
  if (action.kind === "subagent") {
    return config.gates.subagent;
  }
  const toolName = action.toolName ?? String(action.payload?.tool_name ?? "");
  if (toolName === "Shell") {
    return config.gates.toolShell;
  }
  if (toolName === "Write" || toolName === "StrReplace" || toolName === "Delete") {
    return config.gates.fileMutation;
  }
  if (toolName === "Task") {
    return config.gates.subagent;
  }
  return true;
}

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

// src/core/control-plane-spike.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path5 from "node:path";
async function persistControlPlaneSpikeResult(result, env = process.env, homedir = () => env.HOME ?? "", controlPlaneDir) {
  const outputPath = path5.join(
    controlPlaneDir ?? defaultControlPlaneDir(env, homedir),
    "oq3-spike-last.json"
  );
  await mkdir(path5.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ ...result, recordedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`,
    "utf8"
  );
  return outputPath;
}
async function runControlPlaneSpike(env = process.env, cwd = process.cwd(), homedir = () => env.HOME ?? "", controlPlaneDirOverride) {
  const controlPlaneDir = controlPlaneDirOverride ?? defaultControlPlaneDir(env, homedir);
  const testFile = path5.join(controlPlaneDir, "oq3-spike.json");
  const payload = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    cwd,
    pid: process.pid
  };
  const base = {
    ok: false,
    controlPlaneDir,
    testFile,
    home: homedir(),
    xdgConfigHome: env.XDG_CONFIG_HOME?.trim() || null,
    cwd,
    wrote: false,
    readBack: null
  };
  try {
    await mkdir(controlPlaneDir, { recursive: true });
    await writeFile(testFile, `${JSON.stringify(payload)}
`, "utf8");
    const readBack = await readFile(testFile, "utf8");
    const parsed = JSON.parse(readBack.trim());
    await rm(testFile, { force: true });
    return {
      ...base,
      ok: parsed.cwd === cwd && existsSync(controlPlaneDir),
      wrote: true,
      readBack: readBack.trim()
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// src/adapters/shared/gate-runtime.ts
var EMPTY_APPROVALS = {
  version: 1,
  approvals: []
};
async function loadJsonFile(filePath, fallback) {
  try {
    const raw = await readFile2(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function createDefaultGateRuntimeDeps() {
  return {
    async readConfig(configPath) {
      const loaded = await loadJsonFile(configPath, {});
      return mergeConfig(loaded);
    },
    async appendAudit(ctx, event) {
      const auditPath = path6.join(ctx.repoRoot, ctx.config.audit.logPath);
      await mkdir2(path6.dirname(auditPath), { recursive: true });
      const record = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...event };
      if (!ctx.config.audit.includeAssessment) {
        delete record.assessment;
      }
      const scrubbed = scrubValue(record, scrubOptionsFromConfig(ctx.config));
      await writeFile2(auditPath, `${JSON.stringify(scrubbed)}
`, {
        encoding: "utf8",
        flag: "a"
      });
    },
    async loadApprovals(ctx, fileName) {
      const repoLocalStateDir = ctx.layout.repoLocalStateDir(ctx.repoRoot);
      const filePath = fileName === "pending-approvals.json" ? pendingApprovalsFile(ctx.config, repoLocalStateDir) : approvedApprovalsFile(ctx.config, repoLocalStateDir);
      const loaded = await loadJsonFile(filePath, EMPTY_APPROVALS);
      return {
        filePath,
        state: {
          version: 1,
          approvals: Array.isArray(loaded.approvals) ? loaded.approvals : []
        }
      };
    },
    async writeApprovals(filePath, state) {
      await mkdir2(path6.dirname(filePath), { recursive: true });
      await writeFile2(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}
`, "utf8");
    }
  };
}
function gateAuditEventName(kind) {
  if (kind === "shell") {
    return "beforeShellExecution";
  }
  if (kind === "tool") {
    return "preToolUse";
  }
  return "subagentGate";
}
async function ensurePendingApproval(ctx, deps, kind, result) {
  const pending = await deps.loadApprovals(ctx, "pending-approvals.json");
  pending.state = compactApprovals(pending.state);
  const existing = pending.state.approvals.find(
    (approval2) => approval2.kind === kind && approval2.fingerprint === result.fingerprint && approval2.repoRoot === ctx.repoRoot
  );
  if (existing) {
    await deps.writeApprovals(pending.filePath, pending.state);
    return existing;
  }
  const approval = createApprovalRecord({
    kind,
    fingerprint: result.fingerprint,
    repoRoot: ctx.repoRoot,
    reason: result.reason,
    summary: result.normalizedCommand ?? result.summary ?? "",
    approvalTtlMinutes: ctx.config.approvalTtlMinutes,
    approvalId: `belay_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  });
  pending.state.approvals.push(approval);
  await deps.writeApprovals(pending.filePath, pending.state);
  return approval;
}
async function consumeApprovedApproval(ctx, deps, kind, fingerprint) {
  const approved = await deps.loadApprovals(ctx, "approved-approvals.json");
  approved.state = compactApprovals(approved.state);
  const index = approved.state.approvals.findIndex(
    (approval2) => approval2.kind === kind && approval2.fingerprint === fingerprint && approval2.repoRoot === ctx.repoRoot
  );
  if (index === -1) {
    await deps.writeApprovals(approved.filePath, approved.state);
    return null;
  }
  const [approval] = approved.state.approvals.splice(index, 1);
  await deps.writeApprovals(approved.filePath, approved.state);
  return approval;
}
async function evaluateGatedAction(ctx, deps, params) {
  let action;
  try {
    action = normalizeGatedAction({
      kind: params.kind,
      repoRoot: ctx.repoRoot,
      cwd: params.cwd,
      command: params.command,
      payload: params.payload,
      toolName: params.toolName
    });
  } catch {
    const verdict = unnormalizedGateVerdict({
      reason: "normalization_failed",
      mode: ctx.config.mode,
      user_message: "agent-belay could not normalize this gated action. Run agent-belay doctor, then retry.",
      agent_message: "Belay denied this action because the hook payload could not be normalized."
    });
    await deps.appendAudit(ctx, {
      event: gateAuditEventName(params.kind),
      kind: params.kind,
      verdict: verdict.verdict,
      reason: verdict.reason,
      mode: ctx.config.mode,
      wouldBlock: true,
      permission: "deny"
    });
    return verdict;
  }
  if (!gateEnabledForAction(ctx.config, action)) {
    return classifyResultToGateVerdict({
      result: {
        verdict: "allow",
        reason: "gate_disabled",
        fingerprint: "gate_disabled",
        assessment: {
          reversibility: "reversible",
          external: false,
          blastRadius: "none",
          confidence: 1,
          signals: ["gate_disabled"]
        }
      },
      mode: ctx.config.mode,
      permission: "allow",
      wouldBlock: false
    });
  }
  const result = classifyGatedAction(action, ctx.config);
  return gateDecisionToVerdict(ctx, deps, params.kind, result);
}
async function gateDecisionToVerdict(ctx, deps, kind, result) {
  const gateBase = {
    event: gateAuditEventName(kind),
    kind,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? "",
    assessment: result.assessment,
    mode: ctx.config.mode
  };
  const approved = await consumeApprovedApproval(ctx, deps, kind, result.fingerprint);
  if (approved) {
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: "allow",
      reason: "approved_once",
      approvalId: approved.approvalId,
      wouldBlock: false,
      permission: "allow"
    });
    return classifyResultToGateVerdict({
      result: { ...result, verdict: "allow", reason: "approved_once" },
      mode: ctx.config.mode,
      permission: "allow",
      wouldBlock: false,
      approvalId: approved.approvalId
    });
  }
  if (result.verdict === "allow" || result.verdict === "allow_flagged") {
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: result.verdict,
      reason: result.reason,
      wouldBlock: false,
      permission: "allow"
    });
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: "allow",
      wouldBlock: false
    });
  }
  if (ctx.config.mode === "audit") {
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: result.verdict,
      reason: result.reason,
      wouldBlock: true,
      permission: "allow"
    });
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: "allow",
      wouldBlock: true
    });
  }
  const approval = await ensurePendingApproval(ctx, deps, kind, result);
  await deps.appendAudit(ctx, {
    ...gateBase,
    verdict: result.verdict,
    reason: result.reason,
    approvalId: approval.approvalId,
    wouldBlock: true,
    permission: "deny"
  });
  return classifyResultToGateVerdict({
    result,
    mode: ctx.config.mode,
    permission: "deny",
    wouldBlock: true,
    approvalId: approval.approvalId,
    user_message: `Belay blocked this high-risk action. Approval ID: ${approval.approvalId}. ${buildRetryInstruction(ctx.config.tokenPrefix, approval.approvalId)}`,
    agent_message: `Belay denied this action as ${result.reason}. Wait for approval, then retry the exact same action once.`
  });
}
async function processApprovalPrompt(ctx, deps, prompt) {
  const approvalId = approvalCommandMatch(prompt, ctx.config.tokenPrefix);
  if (!approvalId) {
    return { continue: true };
  }
  const pending = await deps.loadApprovals(ctx, "pending-approvals.json");
  pending.state = compactApprovals(pending.state);
  const index = pending.state.approvals.findIndex((approval2) => approval2.approvalId === approvalId);
  if (index === -1) {
    await deps.writeApprovals(pending.filePath, pending.state);
    await deps.appendAudit(ctx, {
      event: "approval",
      kind: "approval",
      verdict: "deny_pending_approval",
      approvalId,
      reason: "approval_missing",
      summary: prompt
    });
    return {
      continue: false,
      user_message: "Belay approval not found or expired."
    };
  }
  const [approval] = pending.state.approvals.splice(index, 1);
  await deps.writeApprovals(pending.filePath, pending.state);
  const approved = await deps.loadApprovals(ctx, "approved-approvals.json");
  approved.state = compactApprovals(approved.state);
  approved.state.approvals.push({
    ...approval,
    approvedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  await deps.writeApprovals(approved.filePath, approved.state);
  await deps.appendAudit(ctx, {
    event: "approval",
    kind: "approval",
    verdict: "allow",
    approvalId,
    reason: "approval_recorded",
    summary: prompt
  });
  return {
    continue: false,
    user_message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`
  };
}
var controlPlaneSpikeRanFor = /* @__PURE__ */ new Set();
async function maybeRunControlPlaneSpike(ctx, deps, envEnabled) {
  if (!envEnabled && !ctx.config.controlPlane.spikeOnPrompt) {
    return;
  }
  const spikeKey = `${ctx.repoRoot}:${ctx.configPath}`;
  if (controlPlaneSpikeRanFor.has(spikeKey)) {
    return;
  }
  controlPlaneSpikeRanFor.add(spikeKey);
  const controlPlaneDir = ctx.config.controlPlane.configDir ?? resolveControlPlaneDir(ctx.config);
  const homedir = () => process.env.HOME ?? process.env.USERPROFILE ?? "";
  const spike = await runControlPlaneSpike(process.env, process.cwd(), homedir, controlPlaneDir);
  const spikePath = await persistControlPlaneSpikeResult(
    spike,
    process.env,
    homedir,
    controlPlaneDir
  );
  await deps.appendAudit(ctx, {
    event: "controlPlaneSpike",
    kind: "diagnostic",
    verdict: spike.ok ? "allow" : "deny_pending_approval",
    reason: spike.ok ? "control_plane_writable" : "control_plane_blocked",
    summary: spike.error ?? spikePath,
    mode: ctx.config.mode,
    wouldBlock: !spike.ok,
    permission: "allow"
  });
}
function gateVerdictToCursorResponse(verdict) {
  return {
    permission: verdict.permission,
    user_message: verdict.user_message,
    agent_message: verdict.agent_message
  };
}
async function appendObservedAudit(ctx, deps, eventName, payload) {
  await deps.appendAudit(ctx, {
    event: eventName,
    kind: "audit",
    verdict: "allow",
    reason: "observed",
    summary: canonicalStringify(payload)
  });
}

// src/adapters/shared/repo-root.ts
import { existsSync as existsSync2 } from "node:fs";
import path7 from "node:path";
function findRepoRoot(startPath, layout) {
  let current = path7.resolve(startPath);
  while (true) {
    for (const marker of layout.repoRootMarkers) {
      if (existsSync2(path7.join(current, marker))) {
        return current;
      }
    }
    const parent = path7.dirname(current);
    if (parent === current) {
      return path7.resolve(startPath);
    }
    current = parent;
  }
}

// src/adapters/cursor/runtime-entry.ts
async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process2.stdin) {
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
function jsonResponse(value) {
  process2.stdout.write(`${JSON.stringify(value)}
`);
}
async function loadRuntimeContext(cwd) {
  const repoRoot = findRepoRoot(cwd, cursorLayout);
  const configPath = cursorLayout.configPath(repoRoot);
  const deps = createDefaultGateRuntimeDeps();
  const config = await deps.readConfig(configPath);
  return { layout: cursorLayout, repoRoot, config, configPath };
}
function isSubagentEvent(payload, eventName) {
  return eventName === "subagentStart" || payload.subagent_type !== void 0;
}
function isFileMutationTool(toolName) {
  return toolName === "Write" || toolName === "StrReplace" || toolName === "Delete";
}
async function runBeforeSubmitPromptHook() {
  try {
    const payload = await readStdinJson();
    const prompt = String(payload.prompt ?? "");
    const ctx = await loadRuntimeContext(process2.cwd());
    const deps = createDefaultGateRuntimeDeps();
    await maybeRunControlPlaneSpike(ctx, deps, process2.env.BELAY_OQ3_SPIKE === "1");
    const result = await processApprovalPrompt(ctx, deps, prompt);
    jsonResponse({
      continue: result.continue,
      ...result.user_message ? { user_message: result.user_message } : {}
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
    const cwd = String(payload.cwd ?? process2.cwd()).trim() || process2.cwd();
    const ctx = await loadRuntimeContext(cwd);
    const deps = createDefaultGateRuntimeDeps();
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: "shell",
      cwd,
      command
    });
    jsonResponse(gateVerdictToCursorResponse(verdict));
  } catch {
    jsonResponse({
      permission: "deny",
      user_message: "agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry."
    });
  }
}
async function runToolGateHook(eventName) {
  try {
    const payload = await readStdinJson();
    const cwd = process2.cwd();
    const ctx = await loadRuntimeContext(cwd);
    const deps = createDefaultGateRuntimeDeps();
    const toolName = String(payload.tool_name ?? "");
    if (isSubagentEvent(payload, eventName)) {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: "subagent",
        cwd,
        payload
      });
      jsonResponse(gateVerdictToCursorResponse(verdict));
      return;
    }
    if (toolName === "Shell") {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: "shell",
        cwd,
        payload,
        toolName
      });
      jsonResponse(gateVerdictToCursorResponse(verdict));
      return;
    }
    if (isFileMutationTool(toolName)) {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: "tool",
        cwd,
        payload,
        toolName
      });
      jsonResponse(gateVerdictToCursorResponse(verdict));
      return;
    }
    if (payload.tool_name === "Task") {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: "subagent",
        cwd,
        payload
      });
      jsonResponse(gateVerdictToCursorResponse(verdict));
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
    const ctx = await loadRuntimeContext(process2.cwd());
    const deps = createDefaultGateRuntimeDeps();
    await appendObservedAudit(ctx, deps, eventName, payload);
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
  runAuditHook,
  runBeforeSubmitPromptHook,
  runShellGateHook,
  runToolGateHook
};
