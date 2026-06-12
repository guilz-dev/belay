// agent-belay claude runtime bundle
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/core/config.ts
import path from "node:path";
function normalizeEgressListenHost(host) {
  const trimmed = host.trim();
  const lowered = trimmed.toLowerCase();
  if (LOOPBACK_EGRESS_HOSTS.has(lowered)) {
    return lowered === "localhost" ? "127.0.0.1" : trimmed;
  }
  return DEFAULT_EGRESS_V3.listenHost;
}
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
    notifications: { ...DEFAULT_NOTIFICATIONS_V3 },
    approvalSigning: { ...DEFAULT_APPROVAL_SIGNING_V3 },
    egress: { ...DEFAULT_EGRESS_V3 },
    sandbox: { ...DEFAULT_SANDBOX_V3 },
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
    },
    notifications: {
      ...base.notifications,
      ...raw.notifications ?? {}
    },
    approvalSigning: {
      ...base.approvalSigning,
      ...raw.approvalSigning ?? {}
    },
    egress: {
      ...base.egress,
      ...raw.egress ?? {}
    },
    sandbox: {
      ...base.sandbox,
      ...raw.sandbox ?? {}
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
      ...LEGACY_POLICY_V3,
      ...raw.policy ?? {}
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
      ...LEGACY_CONTROL_PLANE_V3,
      ...raw.controlPlane ?? {},
      isolation: {
        ...LEGACY_CONTROL_PLANE_V3.isolation,
        ...raw.controlPlane?.isolation ?? {}
      }
    },
    notifications: {
      ...DEFAULT_NOTIFICATIONS_V3,
      ...raw.notifications ?? {}
    },
    approvalSigning: {
      required: raw.approvalSigning?.required === true
    },
    egress: {
      ...DEFAULT_EGRESS_V3,
      ...raw.egress ?? {}
    },
    sandbox: {
      ...DEFAULT_SANDBOX_V3,
      ...raw.sandbox ?? {}
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
      unparseableShell: v3.policy?.unparseableShell === "deny" ? "deny" : v3.policy?.unparseableShell === "allow_flagged" ? "allow_flagged" : DEFAULT_POLICY_V3.unparseableShell,
      confidenceThresholds: {
        allow: typeof v3.policy?.confidenceThresholds?.allow === "number" ? v3.policy.confidenceThresholds.allow : DEFAULT_CONFIDENCE_THRESHOLDS.allow,
        flag: typeof v3.policy?.confidenceThresholds?.flag === "number" ? v3.policy.confidenceThresholds.flag : DEFAULT_CONFIDENCE_THRESHOLDS.flag
      },
      modelAssist: {
        enabled: v3.policy?.modelAssist?.enabled === true,
        model: v3.policy?.modelAssist?.model,
        timeoutMs: typeof v3.policy?.modelAssist?.timeoutMs === "number" ? v3.policy.modelAssist.timeoutMs : DEFAULT_MODEL_ASSIST.timeoutMs
      },
      transactional: (() => {
        let minConfidence = typeof v3.policy?.transactional?.minConfidence === "number" ? v3.policy.transactional.minConfidence : DEFAULT_TRANSACTIONAL_V3.minConfidence;
        let maxConfidence = typeof v3.policy?.transactional?.maxConfidence === "number" ? v3.policy.transactional.maxConfidence : DEFAULT_TRANSACTIONAL_V3.maxConfidence;
        if (minConfidence >= maxConfidence) {
          minConfidence = DEFAULT_TRANSACTIONAL_V3.minConfidence;
          maxConfidence = DEFAULT_TRANSACTIONAL_V3.maxConfidence;
        }
        return {
          enabled: v3.policy?.transactional?.enabled === true,
          minConfidence,
          maxConfidence,
          timeoutMs: typeof v3.policy?.transactional?.timeoutMs === "number" && v3.policy.transactional.timeoutMs > 0 ? v3.policy.transactional.timeoutMs : DEFAULT_TRANSACTIONAL_V3.timeoutMs,
          maxDeletionCount: typeof v3.policy?.transactional?.maxDeletionCount === "number" && v3.policy.transactional.maxDeletionCount >= 0 ? v3.policy.transactional.maxDeletionCount : DEFAULT_TRANSACTIONAL_V3.maxDeletionCount,
          gates: {
            shell: v3.policy?.transactional?.gates?.shell !== false
          }
        };
      })()
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
      spikeOnPrompt: v3.controlPlane?.spikeOnPrompt === true,
      isolation: {
        mode: v3.controlPlane?.isolation?.mode === "read-only-mount" || v3.controlPlane?.isolation?.mode === "separate-user" ? v3.controlPlane.isolation.mode : DEFAULT_CONTROL_PLANE_ISOLATION_V3.mode,
        expectedOwnerUid: typeof v3.controlPlane?.isolation?.expectedOwnerUid === "number" ? v3.controlPlane.isolation.expectedOwnerUid : void 0,
        verifyAgentWritable: v3.controlPlane?.isolation?.verifyAgentWritable !== false
      }
    },
    notifications: {
      webhookUrl: typeof v3.notifications?.webhookUrl === "string" && v3.notifications.webhookUrl.trim() ? v3.notifications.webhookUrl.trim() : void 0,
      commandHook: typeof v3.notifications?.commandHook === "string" && v3.notifications.commandHook.trim() ? v3.notifications.commandHook.trim() : void 0
    },
    approvalSigning: {
      required: v3.approvalSigning?.required === true
    },
    egress: {
      enabled: v3.egress?.enabled === true,
      listenHost: normalizeEgressListenHost(
        typeof v3.egress?.listenHost === "string" && v3.egress.listenHost.trim() ? v3.egress.listenHost.trim() : DEFAULT_EGRESS_V3.listenHost
      ),
      listenPort: typeof v3.egress?.listenPort === "number" && v3.egress.listenPort > 0 ? v3.egress.listenPort : DEFAULT_EGRESS_V3.listenPort,
      demoteL3External: v3.egress?.demoteL3External !== false
    },
    sandbox: {
      enabled: v3.sandbox?.enabled === true,
      runtime: v3.sandbox?.runtime === "cursor-sandbox" || v3.sandbox?.runtime === "container" || v3.sandbox?.runtime === "seatbelt" || v3.sandbox?.runtime === "landlock" ? v3.sandbox.runtime : DEFAULT_SANDBOX_V3.runtime,
      denyNetworkByDefault: v3.sandbox?.denyNetworkByDefault !== false
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
    notifications: {
      ...defaults.notifications,
      ...migrated.notifications
    },
    approvalSigning: {
      ...defaults.approvalSigning,
      ...migrated.approvalSigning
    },
    egress: {
      ...defaults.egress,
      ...migrated.egress
    },
    sandbox: {
      ...defaults.sandbox,
      ...migrated.sandbox
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
    confidenceThresholds: { ...config.policy.confidenceThresholds },
    controlPlaneDir: config.controlPlane.enabled ? resolveControlPlaneDir(config) : null,
    scrubOptions: scrubOptionsFromConfig(config),
    egressEnabled: config.egress.enabled
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
function configuredControlPlaneDir(config) {
  return resolveControlPlaneDir(config);
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
var DEFAULT_CONFIDENCE_THRESHOLDS, DEFAULT_MODEL_ASSIST, DEFAULT_TRANSACTIONAL_V3, LEGACY_POLICY_V3, DEFAULT_POLICY_V3, DEFAULT_OVERRIDES_V3, DEFAULT_REDACTION_V3, DEFAULT_CONTROL_PLANE_ISOLATION_V3, LEGACY_CONTROL_PLANE_V3, DEFAULT_CONTROL_PLANE_V3, DEFAULT_SANDBOX_V3, DEFAULT_NOTIFICATIONS_V3, DEFAULT_APPROVAL_SIGNING_V3, DEFAULT_EGRESS_V3, LOOPBACK_EGRESS_HOSTS, DEFAULT_CONFIG_V2, DEFAULT_CONFIG_V3;
var init_config = __esm({
  "src/core/config.ts"() {
    "use strict";
    DEFAULT_CONFIDENCE_THRESHOLDS = {
      allow: 0.88,
      flag: 0.72
    };
    DEFAULT_MODEL_ASSIST = {
      enabled: false,
      timeoutMs: 3e3
    };
    DEFAULT_TRANSACTIONAL_V3 = {
      enabled: false,
      minConfidence: DEFAULT_CONFIDENCE_THRESHOLDS.flag,
      maxConfidence: DEFAULT_CONFIDENCE_THRESHOLDS.allow,
      timeoutMs: 3e4,
      maxDeletionCount: 10,
      gates: {
        shell: true
      }
    };
    LEGACY_POLICY_V3 = {
      unknownLocalEffect: "allow_flagged",
      unparseableShell: "allow_flagged",
      confidenceThresholds: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
      modelAssist: { ...DEFAULT_MODEL_ASSIST },
      transactional: { ...DEFAULT_TRANSACTIONAL_V3 }
    };
    DEFAULT_POLICY_V3 = {
      unknownLocalEffect: "deny",
      unparseableShell: "deny",
      confidenceThresholds: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
      modelAssist: { ...DEFAULT_MODEL_ASSIST },
      transactional: { ...DEFAULT_TRANSACTIONAL_V3 }
    };
    DEFAULT_OVERRIDES_V3 = {
      allow: [],
      external: []
    };
    DEFAULT_REDACTION_V3 = {
      maskApprovalIds: true,
      maskBearerTokens: true,
      maskAuthHeaders: true,
      maskKeyValueSecrets: true,
      maskHighEntropyStrings: false
    };
    DEFAULT_CONTROL_PLANE_ISOLATION_V3 = {
      mode: "none",
      verifyAgentWritable: true
    };
    LEGACY_CONTROL_PLANE_V3 = {
      enabled: false,
      configDir: null,
      integrity: "none",
      spikeOnPrompt: false,
      isolation: { ...DEFAULT_CONTROL_PLANE_ISOLATION_V3 }
    };
    DEFAULT_CONTROL_PLANE_V3 = {
      enabled: true,
      configDir: null,
      integrity: "hash-pinned",
      spikeOnPrompt: false,
      isolation: { ...DEFAULT_CONTROL_PLANE_ISOLATION_V3 }
    };
    DEFAULT_SANDBOX_V3 = {
      enabled: false,
      runtime: "none",
      denyNetworkByDefault: true
    };
    DEFAULT_NOTIFICATIONS_V3 = {};
    DEFAULT_APPROVAL_SIGNING_V3 = {
      required: false
    };
    DEFAULT_EGRESS_V3 = {
      enabled: false,
      listenHost: "127.0.0.1",
      listenPort: 17831,
      demoteL3External: true
    };
    LOOPBACK_EGRESS_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
    DEFAULT_CONFIG_V2 = {
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
    DEFAULT_CONFIG_V3 = {
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
      notifications: { ...DEFAULT_NOTIFICATIONS_V3 },
      approvalSigning: { ...DEFAULT_APPROVAL_SIGNING_V3 },
      egress: { ...DEFAULT_EGRESS_V3 },
      sandbox: { ...DEFAULT_SANDBOX_V3 },
      audit: { ...DEFAULT_CONFIG_V2.audit }
    };
  }
});

// src/adapters/layouts/claude.ts
import path2 from "node:path";
function runnerCommand(platform, hookName, ...args) {
  const base = platform === "win32" ? ".\\.claude\\hooks\\belay-runner.cmd" : "./.claude/hooks/belay-runner";
  return [base, hookName, ...args].join(" ");
}
var claudeLayout;
var init_claude = __esm({
  "src/adapters/layouts/claude.ts"() {
    "use strict";
    init_config();
    claudeLayout = {
      name: "claude",
      configPath(repoRoot) {
        return path2.join(repoRoot, ".claude", "belay.config.json");
      },
      hooksSettingsPath(repoRoot) {
        return path2.join(repoRoot, ".claude", "settings.json");
      },
      hooksDir(repoRoot) {
        return path2.join(repoRoot, ".claude", "hooks");
      },
      runtimeDir(repoRoot) {
        return path2.join(repoRoot, ".claude", "belay", "runtime");
      },
      repoLocalStateDir(repoRoot) {
        return path2.join(repoRoot, ".claude", "belay");
      },
      defaultAuditLogPath(_repoRoot) {
        return path2.join(".claude", "belay", "audit.ndjson");
      },
      repoRootMarkers: [".git", ".claude"],
      runnerCommand,
      defaultConfig(repoRoot) {
        return {
          ...DEFAULT_CONFIG_V3,
          adapter: "claude",
          audit: {
            ...DEFAULT_CONFIG_V3.audit,
            logPath: claudeLayout.defaultAuditLogPath(repoRoot)
          }
        };
      }
    };
  }
});

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
var init_approval = __esm({
  "src/core/approval.ts"() {
    "use strict";
  }
});

// src/presets.ts
function applyConfigPreset(preset, extra = {}) {
  const base = CONFIG_PRESETS[preset] ?? CONFIG_PRESETS.standard;
  return {
    version: 3,
    ...base,
    ...extra,
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      ...base.policy ?? {},
      ...extra.policy
    },
    sandbox: {
      ...DEFAULT_CONFIG_V3.sandbox,
      ...base.sandbox ?? {},
      ...extra.sandbox
    },
    egress: {
      ...DEFAULT_CONFIG_V3.egress,
      ...base.egress ?? {},
      ...extra.egress
    },
    approvalSigning: {
      ...DEFAULT_CONFIG_V3.approvalSigning,
      ...base.approvalSigning ?? {},
      ...extra.approvalSigning
    },
    controlPlane: {
      ...DEFAULT_CONFIG_V3.controlPlane,
      ...base.controlPlane ?? {},
      ...extra.controlPlane,
      isolation: {
        ...DEFAULT_CONFIG_V3.controlPlane.isolation,
        ...base.controlPlane?.isolation ?? {},
        ...extra.controlPlane?.isolation ?? {}
      }
    }
  };
}
var CONFIG_PRESETS;
var init_presets = __esm({
  "src/presets.ts"() {
    "use strict";
    init_config();
    CONFIG_PRESETS = {
      strict: {
        mode: "enforce",
        policy: {
          unknownLocalEffect: "deny",
          unparseableShell: "deny",
          confidenceThresholds: { allow: 0.9, flag: 0.8 },
          modelAssist: { enabled: false },
          transactional: { ...DEFAULT_CONFIG_V3.policy.transactional }
        },
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox }
      },
      standard: {
        mode: "enforce"
      },
      "audit-first": {
        mode: "audit",
        policy: {
          unknownLocalEffect: "deny",
          unparseableShell: "deny",
          confidenceThresholds: { allow: 0.88, flag: 0.72 },
          modelAssist: { enabled: false },
          transactional: { ...DEFAULT_CONFIG_V3.policy.transactional }
        },
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox }
      },
      "l1-full-recommended": {
        mode: "enforce",
        policy: {
          unknownLocalEffect: "deny",
          unparseableShell: "deny",
          confidenceThresholds: { ...DEFAULT_CONFIG_V3.policy.confidenceThresholds },
          modelAssist: { ...DEFAULT_CONFIG_V3.policy.modelAssist },
          transactional: { ...DEFAULT_CONFIG_V3.policy.transactional }
        },
        sandbox: {
          enabled: true,
          runtime: "container",
          denyNetworkByDefault: true
        },
        egress: {
          ...DEFAULT_CONFIG_V3.egress,
          enabled: true,
          demoteL3External: true
        },
        approvalSigning: {
          required: true
        },
        controlPlane: {
          ...DEFAULT_CONFIG_V3.controlPlane,
          isolation: {
            mode: "separate-user",
            verifyAgentWritable: true
          }
        }
      }
    };
  }
});

// src/core/config-layers.ts
import path6 from "node:path";
function teamConfigPath(homedir = () => process.env.HOME ?? process.env.USERPROFILE ?? "") {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path6.join(homedir(), ".config");
  return path6.join(base, "agent-belay", "team.config.json");
}
function applyProtectedLayer(config, builtin) {
  const controlPlane = { ...config.controlPlane };
  if (builtin.controlPlane.enabled && controlPlane.enabled === false) {
    controlPlane.enabled = true;
  }
  if (builtin.controlPlane.integrity === "hash-pinned" && controlPlane.integrity === "none") {
    controlPlane.integrity = "hash-pinned";
  }
  return {
    ...config,
    controlPlane
  };
}
function asV3Layer(raw) {
  if (!raw || typeof raw !== "object") {
    return { version: 3 };
  }
  return { version: 3, ...raw };
}
function mergeConfigLayer(base, layer) {
  const merged = mergeConfig(layer, base);
  if (!layer.policy) {
    return { ...merged, policy: base.policy };
  }
  return merged;
}
function resolveLayeredConfig(params) {
  const provenance = [{ path: "(builtin)", source: "builtin" }];
  let config = mergeConfig({}, params.adapterDefaults);
  if (params.teamConfig) {
    const teamFile = params.teamConfig;
    const teamRaw = teamFile.preset ? applyConfigPreset(teamFile.preset, teamFile.config ?? {}) : teamFile.config ?? params.teamConfig;
    config = mergeConfigLayer(config, asV3Layer(teamRaw));
    provenance.push({
      path: params.teamConfigPath ?? teamConfigPath(),
      source: "team"
    });
  }
  config = mergeConfigLayer(config, asV3Layer(params.repoConfig));
  if (params.repoConfigPath) {
    provenance.push({ path: params.repoConfigPath, source: "repo" });
  }
  const protectedConfig = applyProtectedLayer(config, DEFAULT_CONFIG_V3);
  if (JSON.stringify(protectedConfig) !== JSON.stringify(config)) {
    provenance.push({ path: "(protected-layer)", source: "protected" });
    config = protectedConfig;
  }
  return { config, provenance };
}
var init_config_layers = __esm({
  "src/core/config-layers.ts"() {
    "use strict";
    init_presets();
    init_config();
  }
});

// src/adapters/layouts/cursor.ts
var init_cursor = __esm({
  "src/adapters/layouts/cursor.ts"() {
    "use strict";
    init_config();
  }
});

// src/adapters/layouts/index.ts
var init_layouts = __esm({
  "src/adapters/layouts/index.ts"() {
    "use strict";
    init_claude();
    init_cursor();
    init_claude();
    init_cursor();
  }
});

// src/config-io.ts
var init_config_io = __esm({
  "src/config-io.ts"() {
    "use strict";
    init_layouts();
    init_approval();
    init_config();
    init_config_layers();
  }
});

// src/adapters/claude/runtime-entry.ts
import process2 from "node:process";

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
    agent_message,
    v2: result.v2
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

// src/adapters/claude/runtime-entry.ts
init_claude();

// src/adapters/shared/gate-runtime.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync8 } from "node:fs";
import { mkdir as mkdir4, readFile as readFile3, writeFile as writeFile3 } from "node:fs/promises";
import path17 from "node:path";

// src/core/approval-service.ts
init_approval();

// src/core/approval-token.ts
init_config();
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path3 from "node:path";
function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}
function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}
function approvalSigningKeyPath(controlPlaneDir = defaultControlPlaneDir()) {
  return path3.join(controlPlaneDir, "approval-signing.key");
}
async function loadOrCreateApprovalSigningKey(controlPlaneDir = defaultControlPlaneDir()) {
  const keyPath = approvalSigningKeyPath(controlPlaneDir);
  if (existsSync(keyPath)) {
    return readFile(keyPath);
  }
  await mkdir(controlPlaneDir, { recursive: true });
  const key = randomBytes(32);
  await writeFile(keyPath, key, { mode: 384 });
  return key;
}
function signPayload(payload, key) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}
async function issueApprovalToken(payload, controlPlaneDir = defaultControlPlaneDir()) {
  const key = await loadOrCreateApprovalSigningKey(controlPlaneDir);
  return signPayload(payload, key);
}
async function verifyApprovalToken(token, controlPlaneDir = defaultControlPlaneDir()) {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }
  const keyPath = approvalSigningKeyPath(controlPlaneDir);
  if (!existsSync(keyPath)) {
    return null;
  }
  const key = await readFile(keyPath);
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (Date.parse(payload.expiresAt) <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// src/core/approval-service.ts
init_config();
async function recordApproval(params) {
  const { approvalId, config, store, token, requireSignedToken = false } = params;
  const pending = await store.loadPending();
  pending.state = compactApprovals(pending.state);
  const index = pending.state.approvals.findIndex((approval2) => approval2.approvalId === approvalId);
  if (index === -1) {
    await store.writePending(pending.filePath, pending.state);
    return { ok: false, message: "Belay approval not found or expired." };
  }
  const [approval] = pending.state.approvals.slice(index, index + 1);
  if (requireSignedToken) {
    if (!token) {
      return { ok: false, message: "Signed approval token required for out-of-band approval." };
    }
    const controlPlaneDir = configuredControlPlaneDir(config);
    const verified = await verifyApprovalToken(token, controlPlaneDir);
    if (!verified || verified.approvalId !== approvalId) {
      return { ok: false, message: "Invalid or expired signed approval token." };
    }
    if (verified.fingerprint !== approval.fingerprint || verified.repoRoot !== approval.repoRoot) {
      return { ok: false, message: "Signed approval token does not match the pending approval." };
    }
  }
  pending.state.approvals.splice(index, 1);
  await store.writePending(pending.filePath, pending.state);
  const approved = await store.loadApproved();
  approved.state = compactApprovals(approved.state);
  approved.state.approvals.push({
    ...approval,
    approvedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  await store.writeApproved(approved.filePath, approved.state);
  return {
    ok: true,
    message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`,
    approval
  };
}

// src/core/capability/allowlist.ts
import { existsSync as existsSync3, readFileSync } from "node:fs";
init_config();
import path5 from "node:path";

// src/core/path-utils.ts
import { existsSync as existsSync2, realpathSync } from "node:fs";
import path4 from "node:path";
function canonicalPath(targetPath) {
  const resolved = path4.resolve(targetPath);
  if (!resolved) {
    return resolved;
  }
  const parsed = path4.parse(resolved);
  let current = parsed.root;
  const relativeParts = path4.relative(parsed.root || ".", resolved).split(path4.sep).filter(Boolean);
  for (let i = 0; i < relativeParts.length; i++) {
    const segment = relativeParts[i];
    if (!segment) {
      continue;
    }
    const candidate = current === "" ? segment : path4.join(current, segment);
    if (!existsSync2(candidate)) {
      return path4.join(candidate, ...relativeParts.slice(i + 1));
    }
    try {
      current = realpathSync.native(candidate);
    } catch {
      return path4.join(candidate, ...relativeParts.slice(i + 1));
    }
  }
  return current;
}
function pathWithinRoot(root, targetPath) {
  const resolvedRoot = canonicalPath(root);
  const resolvedTarget = canonicalPath(targetPath);
  const relativePath = path4.relative(resolvedRoot, resolvedTarget);
  if (relativePath === "") {
    return true;
  }
  return !relativePath.startsWith("..") && !path4.isAbsolute(relativePath);
}
function relativeWithinRepo(repoRoot, targetPath) {
  const resolvedRoot = canonicalPath(repoRoot);
  const resolvedTarget = canonicalPath(targetPath);
  const relativePath = path4.relative(resolvedRoot, resolvedTarget);
  if (relativePath === "") {
    return ".";
  }
  if (relativePath.startsWith("..")) {
    return null;
  }
  return relativePath;
}
function normalizeToken(token, repoRoot) {
  if (!path4.isAbsolute(token)) {
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
  if (path4.isAbsolute(token)) {
    return canonicalPath(token);
  }
  if (token.startsWith("./") || token.startsWith("../")) {
    return canonicalPath(path4.resolve(cwd, token));
  }
  if (!token.includes("/") && !token.includes("\\")) {
    return canonicalPath(path4.resolve(cwd, token));
  }
  return canonicalPath(path4.resolve(cwd, token));
}
function looksLikePathToken(token) {
  if (!token || token === "--" || token.startsWith("-")) {
    return false;
  }
  if (path4.isAbsolute(token)) {
    return true;
  }
  if (token.startsWith("./") || token.startsWith("../")) {
    return true;
  }
  return token.includes("/") || token.includes("\\");
}
function hasOutsideRepoPath(tokens, cwd, repoRoot) {
  return tokens.some((token) => {
    if (!looksLikePathToken(token)) {
      return false;
    }
    const resolved = resolveMutationTarget(token, cwd);
    if (!resolved) {
      return false;
    }
    return relativeWithinRepo(repoRoot, resolved) === null;
  });
}

// src/core/capability/allowlist.ts
function fsScopeAllowlistPath(config, repoLocalStateDir) {
  return path5.join(belayStateDir(config, repoLocalStateDir), "fs-scope-allowlist.json");
}
function loadFsScopeAllowlistSync(filePath) {
  if (!existsSync3(filePath)) {
    return { version: 1, paths: [] };
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return {
    version: 1,
    paths: Array.isArray(raw.paths) ? raw.paths : []
  };
}
function normalizeAllowlistPath(targetPath) {
  return canonicalPath(targetPath);
}
function isPathAllowlisted(absolutePath, allowlist) {
  const resolved = normalizeAllowlistPath(absolutePath);
  return allowlist.paths.some((entry) => {
    const scope = normalizeAllowlistPath(entry.path);
    return resolved === scope || pathWithinRoot(scope, resolved);
  });
}
function allPathsAllowlisted(absolutePaths, allowlist) {
  return absolutePaths.length > 0 && absolutePaths.every((entry) => isPathAllowlisted(entry, allowlist));
}

// src/core/capability/broker.ts
function hasSandboxRuntime(config) {
  return config.sandbox.enabled && config.sandbox.runtime !== "none";
}
function isCapabilityBrokerDemotionActive(config) {
  return hasSandboxRuntime(config);
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
    if (char === "\n" || char === "\r") {
      flush();
      tokens.push(";");
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

// src/core/capability/paths.ts
function collectOutsideRepoPaths(command, cwd, repoRoot) {
  const tokens = tokenizeShell(command);
  const redirects = extractRedirectTargets(tokens);
  const paths = /* @__PURE__ */ new Set();
  for (const token of tokens.slice(1)) {
    const resolved = resolveMutationTarget(token, cwd);
    if (resolved && relativeWithinRepo(repoRoot, resolved) === null) {
      paths.add(resolved);
    }
  }
  for (const redirect of redirects) {
    const resolved = resolveMutationTarget(redirect, cwd);
    if (resolved && relativeWithinRepo(repoRoot, resolved) === null) {
      paths.add(resolved);
    }
  }
  return [...paths];
}

// src/core/capability/reasons.ts
var FS_SCOPE_REASONS = /* @__PURE__ */ new Set(["outside_repo_mutation", "outside_repo_redirect"]);
function shouldSkipBrokerApprovedOnce(brokerActive, reason) {
  return brokerActive && FS_SCOPE_REASONS.has(reason);
}

// src/adapters/shared/gate-runtime.ts
init_config_layers();

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
function shellFingerprint(cwdRelative2, normalizedCommand) {
  return hashValue(`shell:${cwdRelative2}:${normalizedCommand}`);
}
function subagentFingerprint(kind, scrubbed, repoRoot) {
  return hashValue(`subagent:${kind}:${canonicalStringify(scrubbed)}:${repoRoot}`);
}
function toolFingerprint(toolName, scrubbed, repoRoot) {
  return hashValue(`tool:${toolName}:${canonicalStringify(scrubbed)}:${repoRoot}`);
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
import path7 from "node:path";

// src/core/classify-shell.ts
init_config();

// src/core/judgment.ts
var SCOPE_BLAST_RADIUS = {
  none: "none",
  file: "single file",
  dir: "directory tree",
  repo: "this repository",
  outside: "outside the repository",
  external: "external system"
};
function blastRadiusLabel(scope) {
  return SCOPE_BLAST_RADIUS[scope];
}
function computeAssessmentFromAttributes(attributes) {
  const signals = [...attributes.signals];
  if (attributes.isExternalKey || attributes.targetScope === "external") {
    return {
      reversibility: "irreversible",
      external: true,
      blastRadius: blastRadiusLabel(attributes.targetScope),
      confidence: calibrateConfidence(attributes, 0.92),
      signals: [...signals, "external_command", attributes.commandKey]
    };
  }
  if (attributes.hitsProtectedArtifact) {
    return {
      reversibility: "irreversible",
      external: false,
      blastRadius: "agent-belay control plane",
      confidence: calibrateConfidence(attributes, 0.97),
      signals
    };
  }
  if (attributes.hitsOutsideRepo || attributes.redirectKind === "outside") {
    return {
      reversibility: "irreversible",
      external: true,
      blastRadius: "outside the repository",
      confidence: calibrateConfidence(attributes, 0.9),
      signals
    };
  }
  if (attributes.isDynamicEval || attributes.hasPipeToShell) {
    return {
      reversibility: "irreversible",
      external: true,
      blastRadius: "dynamic shell evaluation",
      confidence: calibrateConfidence(attributes, 0.93),
      signals
    };
  }
  if (attributes.isReadOnlyKey && attributes.redirectKind === "none") {
    return {
      reversibility: "reversible",
      external: false,
      blastRadius: blastRadiusLabel("repo"),
      confidence: calibrateConfidence(attributes, 0.95),
      signals: [...signals, "read_only_command"]
    };
  }
  if (attributes.isFlaggedKey || attributes.redirectKind === "truncate" || attributes.redirectKind === "append") {
    const reversibility = attributes.flags.includes("-rf") || attributes.flags.includes("-fr") ? "irreversible" : attributes.redirectKind === "append" ? "recoverable_with_cost" : "recoverable_with_cost";
    return {
      reversibility,
      external: false,
      blastRadius: blastRadiusLabel(attributes.targetScope),
      confidence: calibrateConfidence(attributes, 0.72),
      signals: [...signals, "local_mutation"]
    };
  }
  return {
    reversibility: "recoverable_with_cost",
    external: false,
    blastRadius: blastRadiusLabel(attributes.targetScope),
    confidence: calibrateConfidence(attributes, 0.61),
    signals: [...signals, "unknown_local_effect"]
  };
}
function calibrateConfidence(attributes, base) {
  let confidence = base;
  if (attributes.signals.length >= 2) {
    confidence = Math.min(0.99, confidence + 0.02);
  }
  if (attributes.isCustomAllow && !attributes.isCustomExternal) {
    confidence = Math.max(confidence, 0.99);
  }
  if (attributes.isUnparseable) {
    confidence = Math.max(confidence, 0.9);
  }
  if (attributes.commandKey === "node" || attributes.commandKey === "sed") {
    confidence = Math.min(confidence, 0.64);
  }
  return Math.round(confidence * 1e3) / 1e3;
}
function verdictFromConfidence(assessment, thresholds, unknownLocalEffect) {
  if (assessment.external || assessment.reversibility === "irreversible") {
    if (assessment.confidence >= thresholds.allow && !assessment.external) {
      return "allow_flagged";
    }
    return "deny_pending_approval";
  }
  if (assessment.confidence >= thresholds.allow) {
    return "allow";
  }
  if (assessment.confidence >= thresholds.flag) {
    return "allow_flagged";
  }
  if (unknownLocalEffect === "deny") {
    return "deny_pending_approval";
  }
  return "allow_flagged";
}
function mergeAgentAssessment(independent, agent) {
  if (!agent) {
    return { assessment: independent, mismatch: false };
  }
  const mismatch = agent.external === false && independent.external === true || agent.reversibility === "reversible" && independent.reversibility === "irreversible";
  const confidence = mismatch ? Math.min(independent.confidence, 0.55) : Math.min(0.99, independent.confidence + 0.05);
  return {
    assessment: {
      ...independent,
      confidence,
      signals: mismatch ? [...independent.signals, "agent_assessment_mismatch"] : [...independent.signals, "agent_assessment_agreement"]
    },
    mismatch
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

// src/core/policy/command-keys.ts
var READ_ONLY_COMMAND_KEYS = [
  "cat",
  "cd",
  "echo",
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
  "which",
  "find"
];
var FLAGGED_COMMAND_KEYS = [
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
  "sed",
  "tee",
  "touch",
  "truncate"
];
var EXTERNAL_COMMAND_KEYS = [
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
];
var READ_ONLY_KEYS = new Set(READ_ONLY_COMMAND_KEYS);
var FLAGGED_KEYS = new Set(FLAGGED_COMMAND_KEYS);
var EXTERNAL_KEYS = new Set(EXTERNAL_COMMAND_KEYS);

// src/core/shell-unparseable.ts
function detectUnparseableShell(command) {
  if (hasProcessSubstitution(command)) {
    return true;
  }
  if (hasSubshell(command)) {
    return true;
  }
  if (hasBraceGroup(command)) {
    return true;
  }
  if (hasUnclosedQuote(command)) {
    return true;
  }
  if (hasUnbalancedDollarParen(command)) {
    return true;
  }
  return false;
}
function hasProcessSubstitution(command) {
  return /<\s*\(/.test(command);
}
function hasSubshell(command) {
  const trimmed = command.trim();
  if (trimmed.startsWith("(")) {
    return true;
  }
  return /(?:^|[;&|]\s*)\(/.test(trimmed);
}
function hasBraceGroup(command) {
  const stripped = command.replace(/'[^']*'|"[^"]*"/g, " ");
  return /\{\s*[^\s}]/.test(stripped) || /;\s*\}/.test(stripped);
}
function hasUnclosedQuote(command) {
  let quote = null;
  let escaping = false;
  for (const char of command) {
    if (escaping) {
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
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    }
  }
  return quote !== null;
}
function hasUnbalancedDollarParen(command) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && (inSingle || inDouble)) {
      escaping = true;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
    }
  }
  return depth > 0;
}

// src/core/shell-analysis.ts
var DYNAMIC_KEYS = /* @__PURE__ */ new Set(["eval", "source", "exec"]);
var SHELL_INTERPRETERS = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "fish"]);
var FIND_DANGEROUS = /* @__PURE__ */ new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);
var FORCE_FLAGS = /* @__PURE__ */ new Set(["--force", "-f"]);
var EXTERNAL_SCRIPT_TERMS = ["deploy", "publish", "release", "ship", "prod"];
function protectedRoots(options) {
  return [
    ...options.protectedArtifactRoots ?? [],
    ...options.controlPlaneDir ? [options.controlPlaneDir] : []
  ];
}
function hitsProtected(paths, cwd, roots) {
  if (roots.length === 0) {
    return false;
  }
  return paths.some((target) => {
    const resolved = resolveMutationTarget(target, cwd);
    if (!resolved) {
      return false;
    }
    return roots.some((root) => pathWithinRoot(root, resolved));
  });
}
function redirectKind(redirects, cwd, repoRoot, roots) {
  if (redirects.length === 0) {
    return "none";
  }
  if (hitsProtected(redirects, cwd, roots)) {
    return "protected";
  }
  const hasOutside = redirects.some((target) => {
    const resolved = resolveMutationTarget(target, cwd);
    return resolved !== null && relativeWithinRepo(repoRoot, resolved) === null;
  });
  if (hasOutside) {
    return "outside";
  }
  const tokens = redirects.join(" ");
  if (tokens.includes(">>")) {
    return "append";
  }
  if (redirects.length > 0) {
    return "truncate";
  }
  return "none";
}
function inferTargetScope(segmentTokens, cwd, repoRoot, key) {
  if (EXTERNAL_KEYS.has(key) || key === "curl" || key === "wget") {
    return "external";
  }
  const paths = segmentTokens.slice(1);
  if (hasOutsideRepoPath(paths, cwd, repoRoot)) {
    return "outside";
  }
  if (key === "find" || key === "chmod" || key === "rm") {
    const hasRecursive = segmentTokens.some((token) => token === "-R" || token === "-r");
    if (hasRecursive) {
      return "dir";
    }
  }
  if (FLAGGED_KEYS.has(key)) {
    return "file";
  }
  if (READ_ONLY_KEYS.has(key)) {
    return "repo";
  }
  return "repo";
}
function findDangerousFlags(tokens) {
  return tokens.some(
    (token) => FIND_DANGEROUS.has(token) || token.startsWith("-exec") || token.startsWith("-ok")
  );
}
function isExternalKey(key, normalizedCommand, options) {
  if (EXTERNAL_KEYS.has(key)) {
    return true;
  }
  if (key === "git push" && segmentHasForce(normalizedCommand)) {
    return true;
  }
  return (options.customExternalCommands ?? []).some(
    (pattern) => matchesCustomCommand(normalizedCommand, key, pattern)
  );
}
function segmentHasForce(command) {
  const tokens = tokenizeShell(command);
  return tokens.some((token) => FORCE_FLAGS.has(token));
}
function analyzeShellSegment(params) {
  const { segmentTokens, cwd, repoRoot, normalizedCommand, cwdRelative: cwdRelative2, options, separator } = params;
  const key = commandKey(segmentTokens);
  const flags = segmentTokens.filter((token) => token.startsWith("-"));
  const redirects = extractRedirectTargets(segmentTokens);
  const roots = protectedRoots(options);
  const redirect = redirectKind(redirects, cwd, repoRoot, roots);
  const signals = [];
  const isUnparseable = detectUnparseableShell(normalizedCommand);
  const isDynamicEval = DYNAMIC_KEYS.has(key) || key === "." && segmentTokens.length > 1;
  let hasPipeToShell = segmentTokens.includes("|") && segmentTokens.some((token) => SHELL_INTERPRETERS.has(token));
  if (separator === "|" && SHELL_INTERPRETERS.has(key)) {
    hasPipeToShell = true;
  }
  const hitsProtectedArtifact = hitsProtected(redirects, cwd, roots) || hitsProtected(segmentTokens.slice(1), cwd, roots);
  const hitsOutsideRepo = hasOutsideRepoPath(segmentTokens.slice(1), cwd, repoRoot) || redirect === "outside";
  const hasCredentialHeader = segmentTokens.some(
    (token) => token === "-H" || token === "--header" || /authorization/i.test(token)
  );
  const findDangerous = key === "find" && findDangerousFlags(segmentTokens);
  const isCustomAllow = (options.customAllowCommands ?? []).some(
    (pattern) => matchesCustomCommand(normalizedCommand, key, pattern)
  );
  const isCustomExternal = (options.customExternalCommands ?? []).some(
    (pattern) => matchesCustomCommand(normalizedCommand, key, pattern)
  );
  if (isUnparseable) {
    signals.push("unparseable_shell");
  }
  if (isDynamicEval) {
    signals.push("dynamic_shell_evaluation");
  }
  if (hasPipeToShell) {
    signals.push("pipe_to_shell");
  }
  if (hitsProtectedArtifact) {
    signals.push("control_plane_path");
  }
  if (hitsOutsideRepo) {
    signals.push("outside_repo_mutation");
  }
  if (hasCredentialHeader) {
    signals.push("credential_header");
  }
  if (findDangerous) {
    signals.push("find_dangerous_action");
  }
  if (key === "rm" && flags.some((flag) => flag === "-rf" || flag === "-fr")) {
    signals.push("rm_recursive_force");
  }
  if (key === "git push" && segmentHasForce(normalizedCommand)) {
    signals.push("git_push_force");
  }
  if (key === "docker run" && flags.includes("--privileged")) {
    signals.push("docker_privileged");
  }
  if (key === "sed" && flags.some((flag) => flag === "-i" || flag === "--in-place")) {
    signals.push("sed_in_place");
  }
  if ((key === "npm run" || key === "pnpm run") && segmentTokens[2]) {
    const scriptName = segmentTokens[2].toLowerCase();
    if (EXTERNAL_SCRIPT_TERMS.some((term) => scriptName.includes(term))) {
      signals.push("external_script_name", scriptName);
    }
  }
  return {
    commandKey: key,
    normalizedCommand,
    cwdRelative: cwdRelative2,
    flags,
    targetScope: inferTargetScope(segmentTokens, cwd, repoRoot, key),
    redirectKind: redirect,
    signals,
    isUnparseable,
    isDynamicEval,
    hasPipeToShell,
    hitsProtectedArtifact,
    hitsOutsideRepo,
    isCustomAllow,
    isCustomExternal,
    isReadOnlyKey: READ_ONLY_KEYS.has(key) && redirect === "none",
    isFlaggedKey: FLAGGED_KEYS.has(key),
    isExternalKey: isExternalKey(key, normalizedCommand, options),
    hasCredentialHeader,
    findDangerous
  };
}
function matchesPolicyRule(match, attributes) {
  if (match.signal && !attributes.signals.includes(match.signal)) {
    return false;
  }
  if (match.commandKey) {
    const keys = Array.isArray(match.commandKey) ? match.commandKey : [match.commandKey];
    if (!keys.includes(attributes.commandKey)) {
      return false;
    }
  }
  if (match.targetScope) {
    const scopes = Array.isArray(match.targetScope) ? match.targetScope : [match.targetScope];
    if (!scopes.includes(attributes.targetScope)) {
      return false;
    }
  }
  if (match.redirectKind) {
    const kinds = Array.isArray(match.redirectKind) ? match.redirectKind : [match.redirectKind];
    if (!kinds.includes(attributes.redirectKind)) {
      return false;
    }
  }
  if (match.flag) {
    const flags = Array.isArray(match.flag) ? match.flag : [match.flag];
    if (!flags.some((flag) => attributes.flags.includes(flag))) {
      return false;
    }
  }
  if (match.customAllow === true && !attributes.isCustomAllow) {
    return false;
  }
  if (match.customExternal === true && !attributes.isCustomExternal) {
    return false;
  }
  if (match.unparseable === true && !attributes.isUnparseable) {
    return false;
  }
  if (match.protectedArtifact === true && !attributes.hitsProtectedArtifact) {
    return false;
  }
  if (match.outsideRepo === true && !attributes.hitsOutsideRepo) {
    return false;
  }
  return true;
}

// src/core/policy/default-rules.ts
var DEFAULT_POLICY_RULES = [
  {
    id: "unparseable_shell",
    priority: 1e3,
    nonOverridable: true,
    match: { unparseable: true },
    action: "threshold",
    reason: "unparseable_shell"
  },
  {
    id: "protected_artifact",
    priority: 950,
    nonOverridable: true,
    match: { protectedArtifact: true },
    action: "escalate",
    reason: "control_plane_mutation"
  },
  {
    id: "outside_repo_redirect",
    priority: 940,
    nonOverridable: true,
    match: { redirectKind: "outside" },
    action: "escalate",
    reason: "outside_repo_redirect"
  },
  {
    id: "outside_repo_mutation",
    priority: 938,
    nonOverridable: true,
    match: { outsideRepo: true },
    action: "escalate",
    reason: "outside_repo_mutation"
  },
  {
    id: "dynamic_shell",
    priority: 930,
    nonOverridable: true,
    match: { signal: "dynamic_shell_evaluation" },
    action: "escalate",
    reason: "dynamic_shell_evaluation"
  },
  {
    id: "pipe_to_shell",
    priority: 920,
    nonOverridable: true,
    match: { signal: "pipe_to_shell" },
    action: "escalate",
    reason: "pipe_to_shell"
  },
  {
    id: "find_dangerous",
    priority: 900,
    nonOverridable: true,
    match: { signal: "find_dangerous_action" },
    action: "escalate",
    reason: "find_dangerous_action"
  },
  {
    id: "custom_external",
    priority: 850,
    match: { customExternal: true },
    action: "escalate",
    reason: "custom_external"
  },
  {
    id: "external_effect",
    priority: 800,
    nonOverridable: true,
    match: { targetScope: "external" },
    action: "escalate",
    reason: "external_effect"
  },
  {
    id: "external_script",
    priority: 790,
    match: { commandKey: ["npm run", "pnpm run"], signal: "external_script_name" },
    action: "escalate",
    reason: "external_script"
  },
  {
    id: "custom_allow",
    priority: 600,
    match: { customAllow: true },
    action: "allow",
    reason: "custom_allow"
  },
  {
    id: "read_only",
    priority: 500,
    match: {
      commandKey: [...READ_ONLY_COMMAND_KEYS],
      redirectKind: "none"
    },
    action: "allow",
    reason: "read_only"
  },
  {
    id: "local_mutation",
    priority: 400,
    match: {
      commandKey: [...FLAGGED_COMMAND_KEYS]
    },
    action: "flag",
    reason: "local_mutation"
  },
  {
    id: "unknown_local",
    priority: 100,
    match: {},
    action: "threshold",
    reason: "unknown_local_effect"
  }
];

// src/core/policy/evaluator.ts
function actionToVerdict(action, ctx) {
  if (action === "allow") {
    return "allow";
  }
  if (action === "flag") {
    return "allow_flagged";
  }
  if (action === "deny" || action === "escalate") {
    return "deny_pending_approval";
  }
  if (action === "threshold") {
    if (ctx.attributes.isUnparseable) {
      return ctx.unparseableShell === "deny" ? "deny_pending_approval" : "allow_flagged";
    }
    return verdictFromConfidence(ctx.assessment, ctx.confidenceThresholds, ctx.unknownLocalEffect);
  }
  return "allow_flagged";
}
function evaluatePolicyRules(attributes, ctx, rules = DEFAULT_POLICY_RULES) {
  const assessment = computeAssessmentFromAttributes(attributes);
  const fullCtx = { ...ctx, attributes, assessment };
  const sorted = [...rules].sort((left, right) => right.priority - left.priority);
  if (attributes.isCustomAllow && attributes.isCustomExternal) {
    return {
      verdict: "allow",
      reason: "custom_allow",
      assessment: {
        ...assessment,
        confidence: 0.99,
        signals: [...assessment.signals, "custom_allow_command"]
      },
      matchedRuleId: "custom_allow_over_external"
    };
  }
  for (const rule of sorted) {
    if (!matchesPolicyRule(rule.match, attributes)) {
      continue;
    }
    if (rule.id === "custom_allow" && attributes.isCustomExternal && !rule.nonOverridable) {
      continue;
    }
    if (rule.id === "custom_external" && attributes.isCustomAllow && attributes.isCustomExternal) {
      continue;
    }
    let verdict2 = actionToVerdict(rule.action, fullCtx);
    let reason = rule.reason;
    let resultAssessment = rule.assessment ? { ...assessment, ...rule.assessment } : assessment;
    if (ctx.demoteL3External && verdict2 === "deny_pending_approval" && (rule.id === "external_effect" || rule.id === "custom_external" || rule.id === "external_script")) {
      verdict2 = "allow_flagged";
      reason = "l3_external_hint";
      resultAssessment = {
        ...resultAssessment,
        signals: [...resultAssessment.signals, "l3_external_hint", "egress_boundary_expected"]
      };
    }
    if (ctx.brokerFsScope && verdict2 === "deny_pending_approval" && (rule.id === "outside_repo_mutation" || rule.id === "outside_repo_redirect") && ctx.outsideRepoPaths && ctx.fsScopeAllowlist && allPathsAllowlisted(ctx.outsideRepoPaths, ctx.fsScopeAllowlist)) {
      verdict2 = "allow_flagged";
      reason = "capability_fs_hint";
      resultAssessment = {
        ...resultAssessment,
        signals: [...resultAssessment.signals, "capability_fs_hint", "sandbox_boundary_expected"]
      };
    }
    return {
      verdict: verdict2,
      reason,
      assessment: resultAssessment,
      matchedRuleId: rule.id
    };
  }
  return {
    verdict: verdictFromConfidence(assessment, ctx.confidenceThresholds, ctx.unknownLocalEffect),
    reason: "unknown_local_effect",
    assessment,
    matchedRuleId: "fallback"
  };
}
function policyResultToClassifyResult(attributes, result) {
  return {
    verdict: result.verdict,
    reason: result.reason,
    normalizedCommand: attributes.normalizedCommand,
    fingerprint: shellFingerprint(attributes.cwdRelative, attributes.normalizedCommand),
    assessment: result.assessment
  };
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

// src/core/classify-shell.ts
var SHELL_INTERPRETERS2 = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "fish"]);
var INTERPRETER_SCRIPT_FLAGS = /* @__PURE__ */ new Set(["-c", "-lc", "-e", "--eval"]);
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
function unparseableShellResult(normalizedCommand, cwdRelative2, options) {
  const assessment = {
    reversibility: "irreversible",
    external: false,
    blastRadius: "unparseable shell construct",
    confidence: 0.9,
    signals: ["unparseable_shell"]
  };
  if (options.unparseableShell === "deny") {
    return denyResult({
      reason: "unparseable_shell",
      normalizedCommand,
      cwdRelative: cwdRelative2,
      assessment
    });
  }
  return {
    verdict: "allow_flagged",
    reason: "unparseable_shell",
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative2, normalizedCommand),
    assessment
  };
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
  const cwdRelative2 = relativeWithinRepo(repoRoot, cwd) ?? cwd;
  let worst = null;
  for (const substitution of substitutions) {
    const inner = classifyShell(substitution, cwd, repoRoot, options, depth + 1);
    if (options.unknownLocalEffect === "deny") {
      return denyResult({
        reason: "command_substitution",
        normalizedCommand,
        cwdRelative: cwdRelative2,
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
      cwdRelative: cwdRelative2,
      wrapReason: "command_substitution",
      wrapSignal: "command_substitution"
    });
    worst = worst ? worseVerdict(worst, wrapped) : wrapped;
  }
  return worst;
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
function wrapInnerVerdict(params) {
  const { inner, normalizedCommand, cwdRelative: cwdRelative2, wrapReason, wrapSignal } = params;
  const signals = [wrapSignal, ...inner.assessment.signals];
  if (inner.verdict === "deny_pending_approval") {
    return {
      ...inner,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative2, normalizedCommand),
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
      fingerprint: shellFingerprint(cwdRelative2, normalizedCommand),
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
      fingerprint: shellFingerprint(cwdRelative2, normalizedCommand),
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
function classifySegment(segment, cwd, repoRoot, normalizedCommand, cwdRelative2, options, depth) {
  const segmentTokens = segment.tokens;
  const key = commandKey(segmentTokens);
  if (depth < 2) {
    const innerScript = extractInterpreterScript(segmentTokens);
    if (innerScript && (SHELL_INTERPRETERS2.has(key) || key === "node")) {
      const inner = classifyShell(innerScript, cwd, repoRoot, options, depth + 1);
      const wrapReason = key === "node" ? "node_eval" : "shell_interpreter_script";
      const wrapSignal = key === "node" ? "node_eval" : "shell_interpreter_script";
      return wrapInnerVerdict({
        inner,
        normalizedCommand,
        cwdRelative: cwdRelative2,
        wrapReason,
        wrapSignal
      });
    }
  }
  const attributes = analyzeShellSegment({
    segmentTokens,
    cwd,
    repoRoot,
    normalizedCommand,
    cwdRelative: cwdRelative2,
    options,
    separator: segment.separator
  });
  const outsideRepoPaths = attributes.hitsOutsideRepo ? collectOutsideRepoPaths(normalizedCommand, cwd, repoRoot) : [];
  const policyResult = evaluatePolicyRules(attributes, {
    unknownLocalEffect: options.unknownLocalEffect ?? "allow_flagged",
    unparseableShell: options.unparseableShell ?? "allow_flagged",
    confidenceThresholds: options.confidenceThresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS,
    demoteL3External: options.demoteL3External === true,
    brokerFsScope: options.brokerFsScope === true,
    fsScopeAllowlist: options.fsScopeAllowlist,
    outsideRepoPaths
  });
  return policyResultToClassifyResult(attributes, policyResult);
}
function classifyShell(command, cwd, repoRoot, options = {}, depth = 0) {
  const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken);
  const cwdRelative2 = relativeWithinRepo(repoRoot, cwd) ?? cwd;
  if (depth === 0 && detectUnparseableShell(command)) {
    return unparseableShellResult(normalizedCommand, cwdRelative2, options);
  }
  const substitutionResult = classifySubstitutionInners({
    command,
    cwd,
    repoRoot,
    options,
    depth
  });
  const tokens = tokenizeShell(command);
  const segments = splitSegmentsWithSeparators(tokens);
  let effective = {
    verdict: "allow",
    reason: "read_only",
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative2, normalizedCommand),
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
      cwdRelative2,
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
  const protectedRoots2 = [
    ...options.protectedArtifactRoots ?? [],
    ...options.controlPlaneDir ? [options.controlPlaneDir] : []
  ];
  if (toolName === "Shell") {
    const command = extractShellCommand(payload);
    if (!command) {
      if (options.unknownLocalEffect === "deny") {
        return {
          verdict: "deny_pending_approval",
          reason: "tool_shell_missing_command",
          summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
          fingerprint: toolFingerprint(
            toolName,
            scrubPayload(payload.tool_input ?? {}, options),
            repoRoot
          ),
          assessment: {
            reversibility: "irreversible",
            external: false,
            blastRadius: "tool shell",
            confidence: 0.85,
            signals: ["missing_command"]
          }
        };
      }
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
      if (options.unknownLocalEffect === "deny") {
        return {
          verdict: "deny_pending_approval",
          reason: "file_mutation_missing_path",
          summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
          fingerprint: toolFingerprint(
            toolName,
            scrubPayload(payload.tool_input ?? {}, options),
            repoRoot
          ),
          assessment: {
            reversibility: "irreversible",
            external: false,
            blastRadius: "file mutation",
            confidence: 0.85,
            signals: ["missing_path"]
          }
        };
      }
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
    const resolvedPath = path7.isAbsolute(filePath) ? filePath : path7.resolve(cwd, filePath);
    const hitsProtectedRoot = protectedRoots2.some((root) => pathWithinRoot(root, resolvedPath));
    if (hitsProtectedRoot) {
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
init_config();

// src/core/v2/judge.ts
var SECRET_PATTERNS = [/\.env\b/i, /\.pem\b/i, /id_rsa\b/i, /credentials/i, /secrets?\b/i];
var DESTRUCTIVE_VERBS = /\b(rm|rmtree|unlink|delete|truncate|shred|destroy|drop)\b/i;
var GIT_PATTERNS = /\.git\b/i;
function prescanInterpreterCode(code) {
  const normalized = code.replaceAll("\\", "/");
  const hitsSecret = SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
  const hitsGit = GIT_PATTERNS.test(normalized);
  const hitsDestructive = DESTRUCTIVE_VERBS.test(normalized);
  if ((hitsSecret || hitsGit) && hitsDestructive) {
    return {
      external_change: false,
      destroys_outside_repo: false,
      destroys_history_or_secrets: true
    };
  }
  return null;
}
function createDeterministicJudgeStub() {
  return {
    evaluate() {
      return Promise.resolve({
        external_change: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: false
      });
    }
  };
}
var TIER1_PROMPT = `Answer ONLY with JSON: {"external_change":boolean,"destroys_outside_repo":boolean,"destroys_history_or_secrets":boolean}
Default all three to true when unsure.

external_change: CREATE/MODIFY/DELETE on database, network endpoint, cloud, remote git, registry, queue. READ/QUERY/GET is NOT a change.
destroys_outside_repo: DELETE/OVERWRITE files OUTSIDE the current repository working tree.
destroys_history_or_secrets: DELETE/OVERWRITE .git directory OR secret/credential files (.env, *.pem, id_rsa, credentials).

Command/code:
`;
function createOllamaJudge(model = "gemma4:e2b", baseUrl = "http://127.0.0.1:11434") {
  return {
    async evaluate(input) {
      const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null;
      if (prescan?.destroys_history_or_secrets) {
        return prescan;
      }
      const body = `${TIER1_PROMPT}${input.innerCode ?? input.command}`;
      try {
        const response = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: body,
            stream: false,
            format: "json"
          })
        });
        if (!response.ok) {
          return {
            external_change: true,
            destroys_outside_repo: true,
            destroys_history_or_secrets: true
          };
        }
        const payload = await response.json();
        const parsed = JSON.parse(payload.response ?? "{}");
        return {
          external_change: parsed.external_change !== false,
          destroys_outside_repo: parsed.destroys_outside_repo !== false,
          destroys_history_or_secrets: parsed.destroys_history_or_secrets !== false
        };
      } catch {
        return {
          external_change: true,
          destroys_outside_repo: true,
          destroys_history_or_secrets: true
        };
      }
    }
  };
}
function tier1RequiresAsk(verdict2) {
  return verdict2.external_change || verdict2.destroys_outside_repo || verdict2.destroys_history_or_secrets;
}

// src/core/v2/verdict.ts
import path11 from "node:path";

// src/core/v2/containment.ts
import path8 from "node:path";
function expandHome(token) {
  if (token === "~" || token.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (!home) {
      return token;
    }
    return token === "~" ? home : path8.join(home, token.slice(2));
  }
  return token;
}
function resolveTrustedPath(token, trustedCwd, trusted) {
  if (!token || token === "--" || token.startsWith("-")) {
    return null;
  }
  if (!trusted || !trustedCwd) {
    return null;
  }
  const expanded = expandHome(token);
  if (path8.isAbsolute(expanded)) {
    return canonicalPath(expanded);
  }
  return canonicalPath(path8.resolve(trustedCwd, expanded));
}
function locationForPath(resolvedPath, repoRoot) {
  if (!resolvedPath) {
    return "unknown";
  }
  if (pathWithinRoot(repoRoot, resolvedPath)) {
    return "repo_local";
  }
  return "repo_outside";
}
function isGitPath(resolvedPath, repoRoot) {
  const relative = relativeWithinRepo(repoRoot, resolvedPath);
  if (!relative) {
    return false;
  }
  const normalized = relative.replaceAll("\\", "/");
  return normalized === ".git" || normalized.startsWith(".git/");
}
function isHighStakesPath(resolvedPath, repoRoot, sensitivePaths, protectedRoots2 = []) {
  if (isGitPath(resolvedPath, repoRoot)) {
    return true;
  }
  const relative = relativeWithinRepo(repoRoot, resolvedPath);
  const checkPath = relative ?? resolvedPath;
  if (matchesSensitivePath(checkPath.replaceAll("\\", "/"), sensitivePaths)) {
    return true;
  }
  return protectedRoots2.some((root) => pathWithinRoot(root, resolvedPath));
}
function analyzePathTargets(params) {
  const signals = [];
  if (!params.trustedCwd || !params.cwd) {
    return {
      location: "unknown",
      isHighStakes: false,
      signals: ["missing_trusted_cwd"]
    };
  }
  const locations = /* @__PURE__ */ new Set();
  let isHighStakes = false;
  for (const target of params.targets) {
    const resolved = resolveTrustedPath(target, params.cwd, params.trustedCwd) ?? resolveMutationTarget(target, params.cwd);
    const location2 = locationForPath(resolved, params.repoRoot);
    locations.add(location2);
    if (resolved && isHighStakesPath(
      resolved,
      params.repoRoot,
      params.sensitivePaths,
      params.protectedArtifactRoots
    )) {
      isHighStakes = true;
      signals.push("high_stakes_path");
    }
  }
  let location = "unknown";
  if (locations.size === 0) {
    location = "unknown";
  } else if (locations.size === 1) {
    location = [...locations][0] ?? "unknown";
  } else {
    location = "mixed";
  }
  return { location, isHighStakes, signals };
}
function cwdRelative(repoRoot, cwd) {
  return relativeWithinRepo(repoRoot, cwd) ?? cwd;
}

// src/core/v2/fingerprint.ts
function verdictFingerprint(cwdRelative2, commandRedacted) {
  return hashValue(`v2:${cwdRelative2}:${commandRedacted}`);
}

// src/core/v2/launcher-resolve.ts
import { existsSync as existsSync4, readFileSync as readFileSync2 } from "node:fs";
import path9 from "node:path";
var MAX_RESOLVE_DEPTH = 8;
function readPackageJson(dir) {
  const packagePath = path9.join(dir, "package.json");
  if (!existsSync4(packagePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync2(packagePath, "utf8"));
  } catch {
    return null;
  }
}
function findPackageJson(startDir, stopDir) {
  let current = path9.resolve(startDir);
  const stop = path9.resolve(stopDir);
  while (true) {
    const packagePath = path9.join(current, "package.json");
    if (existsSync4(packagePath)) {
      return packagePath;
    }
    if (current === stop || current === path9.dirname(current)) {
      return existsSync4(packagePath) ? packagePath : null;
    }
    const parent = path9.dirname(current);
    if (!parent.startsWith(stop) && parent !== current) {
    }
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}
function npmScriptName(tokens) {
  if (tokens[0] === "npm" && tokens[1] === "test") {
    return "test";
  }
  if (tokens[0] === "npm" && tokens[1] === "run" && tokens[2]) {
    return tokens[2];
  }
  if (tokens[0] === "pnpm" && tokens[1] === "run" && tokens[2]) {
    return tokens[2];
  }
  if (tokens[0] === "npm" && tokens[1] && tokens[1] !== "run" && tokens[1] !== "install") {
    return null;
  }
  return null;
}
function resolveNpmRecipe(cwd, repoRoot, scriptName) {
  const packagePath = findPackageJson(cwd, repoRoot) ?? findPackageJson(cwd, cwd);
  if (!packagePath) {
    return { recipe: null, opaque: true, reason: "package_json_missing" };
  }
  const pkg = readPackageJson(path9.dirname(packagePath));
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return { recipe: null, opaque: true, reason: "package_scripts_missing" };
  }
  const recipe = scripts[scriptName];
  if (!recipe || typeof recipe !== "string") {
    return { recipe: null, opaque: true, reason: "npm_script_undefined" };
  }
  if (/\$\(/.test(recipe) || /\$\{/.test(recipe)) {
    return { recipe: null, opaque: true, reason: "npm_script_dynamic" };
  }
  return { recipe: recipe.trim(), opaque: false, reason: "npm_script_resolved" };
}
function parseMakefileRecipes(makefilePath) {
  const recipes = /* @__PURE__ */ new Map();
  try {
    const content = readFileSync2(makefilePath, "utf8");
    const lines = content.split("\n");
    let currentTarget = null;
    let recipeLines = [];
    const flush = () => {
      if (currentTarget && recipeLines.length > 0) {
        recipes.set(currentTarget, recipeLines.join(" ").trim());
      }
      currentTarget = null;
      recipeLines = [];
    };
    for (const line of lines) {
      if (line.trim().startsWith("#")) {
        continue;
      }
      const targetMatch = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
      if (targetMatch) {
        flush();
        currentTarget = targetMatch[1] ?? null;
        const inline = line.slice(targetMatch[0].length).trim();
        if (inline && !inline.startsWith("#")) {
          recipeLines.push(inline);
        }
        continue;
      }
      if (currentTarget && /^\t/.test(line)) {
        recipeLines.push(line.trim());
      }
    }
    flush();
  } catch {
    return recipes;
  }
  return recipes;
}
function resolveMakeRecipe(cwd, repoRoot, target) {
  const candidates = ["Makefile", "makefile", "GNUmakefile"];
  let makefilePath = null;
  let searchDir = path9.resolve(cwd);
  const stop = path9.resolve(repoRoot);
  while (true) {
    for (const name of candidates) {
      const candidate = path9.join(searchDir, name);
      if (existsSync4(candidate)) {
        makefilePath = candidate;
        break;
      }
    }
    if (makefilePath || searchDir === stop || searchDir === path9.dirname(searchDir)) {
      break;
    }
    searchDir = path9.dirname(searchDir);
  }
  if (!makefilePath) {
    return { recipe: null, opaque: true, reason: "makefile_missing" };
  }
  const recipes = parseMakefileRecipes(makefilePath);
  const recipe = recipes.get(target);
  if (!recipe) {
    return { recipe: null, opaque: true, reason: "make_target_undefined" };
  }
  if (/\$\(/.test(recipe) || /\$\{/.test(recipe)) {
    return { recipe: null, opaque: true, reason: "make_recipe_dynamic" };
  }
  return { recipe: recipe.trim(), opaque: false, reason: "make_recipe_resolved" };
}
function resolveLauncherRecipe(params) {
  if (params.depth >= MAX_RESOLVE_DEPTH) {
    return { recipe: null, opaque: true, reason: "launcher_depth_exceeded" };
  }
  const tokens = params.tokens;
  const scriptName = npmScriptName(tokens);
  if (scriptName) {
    return resolveNpmRecipe(params.cwd, params.repoRoot, scriptName);
  }
  if (tokens[0] === "make" && tokens[1] && !tokens[1].startsWith("-")) {
    return resolveMakeRecipe(params.cwd, params.repoRoot, tokens[1]);
  }
  return null;
}
function isRoutineLauncher(tokens) {
  return tokens[0] === "npm" && (tokens[1] === "run" || tokens[1] === "test") || tokens[0] === "pnpm" || tokens[0] === "make";
}

// src/core/v2/parser.ts
import path10 from "node:path";
var ENV_PREFIX_PATTERN2 = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/;
var TRANSPARENT_WRAPPERS = /* @__PURE__ */ new Set([
  "sudo",
  "env",
  "nohup",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "setsid"
]);
var SHELL_INTERPRETERS3 = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "fish"]);
var CODE_INTERPRETERS = /* @__PURE__ */ new Set(["python", "python3", "node", "ruby", "perl", "osascript"]);
var SCRIPT_FLAGS = /* @__PURE__ */ new Set(["-c", "-lc", "-e", "--eval"]);
var INTERPRETER_SCRIPT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".py",
  ".rb",
  ".pl",
  ".sh"
]);
function normalizeHead(token) {
  const base = path10.basename(token);
  if (base && base !== "." && base !== "..") {
    return base;
  }
  return token;
}
function peelTransparentWrappers(tokens) {
  let current = [...tokens];
  let xargsStdinOpaque = false;
  while (current.length > 0) {
    while (current.length > 0 && ENV_PREFIX_PATTERN2.test(current[0] ?? "")) {
      current.shift();
    }
    if (current.length === 0) {
      break;
    }
    const head = normalizeHead(current[0] ?? "");
    if (!TRANSPARENT_WRAPPERS.has(head)) {
      break;
    }
    if (head === "xargs") {
      let index = 1;
      while (index < current.length && current[index]?.startsWith("-")) {
        index += 1;
      }
      const rest = current.slice(index);
      if (rest.length === 0) {
        xargsStdinOpaque = true;
        return { tokens: [], xargsStdinOpaque: true };
      }
      current = rest;
      continue;
    }
    if (head === "env") {
      let index = 1;
      while (index < current.length) {
        const token = current[index] ?? "";
        if (ENV_PREFIX_PATTERN2.test(token) || token.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      current = current.slice(index);
      continue;
    }
    current = current.slice(1);
  }
  return { tokens: current, xargsStdinOpaque };
}
function isVariableIndirectHead(head) {
  return head.startsWith("$");
}
function extractEvalBody(tokens) {
  const head = normalizeHead(tokens[0] ?? "");
  if (head !== "eval") {
    return null;
  }
  const body = tokens.slice(1).join(" ").trim();
  return body || null;
}
function extractRecursiveScript(tokens) {
  const filtered = tokens.filter((token) => token !== "sudo");
  const head = normalizeHead(filtered[0] ?? "");
  const second = filtered[1] ?? "";
  if (head === "eval") {
    return extractEvalBody(tokens);
  }
  if (SHELL_INTERPRETERS3.has(head) || CODE_INTERPRETERS.has(head)) {
    const flagIndex = filtered.findIndex((token) => SCRIPT_FLAGS.has(token));
    if (flagIndex !== -1) {
      const body = filtered.slice(flagIndex + 1).join(" ").replace(/^['"]|['"]$/g, "").trim();
      return body || null;
    }
  }
  if (head === "bash" && (second === "-lc" || second === "-c")) {
    const body = filtered.slice(2).join(" ").replace(/^['"]|['"]$/g, "").trim();
    return body || null;
  }
  return null;
}
function isBareInterpreter(tokens) {
  const { tokens: peeled, xargsStdinOpaque } = peelTransparentWrappers(tokens);
  if (xargsStdinOpaque) {
    return true;
  }
  if (peeled.length === 0) {
    return false;
  }
  const head = normalizeHead(peeled[0] ?? "");
  if (!SHELL_INTERPRETERS3.has(head) && !CODE_INTERPRETERS.has(head)) {
    return false;
  }
  const hasScriptFlag = peeled.some((token) => SCRIPT_FLAGS.has(token));
  if (hasScriptFlag) {
    return false;
  }
  const scriptArg = peeled[1];
  if (scriptArg && INTERPRETER_SCRIPT_EXTENSIONS.has(path10.extname(scriptArg))) {
    return false;
  }
  if (scriptArg && !scriptArg.startsWith("-")) {
    return false;
  }
  return true;
}
function splitTopLevelSegments(command) {
  const tokens = tokenizeShell(command);
  const segments = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) {
      segments.push(current.join(" "));
      current = [];
    }
  };
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === ";" || token === "|" || token === "&") {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return segments.filter((segment) => segment.trim().length > 0);
}
function parseSegment(command) {
  const tokens = tokenizeShell(command);
  const { tokens: peeled } = peelTransparentWrappers(tokens);
  const normalizedTokens = peeled.map((token) => normalizeHead(token));
  const key = commandKey(peeled.map((token, index) => index === 0 ? normalizeHead(token) : token));
  return {
    tokens: peeled,
    head: normalizeHead(peeled[0] ?? ""),
    key,
    normalized: normalizedTokens.join(" ").trim()
  };
}
function segmentOpacity(command) {
  if (detectUnparseableShell(command)) {
    return "unparseable";
  }
  const tokens = tokenizeShell(command);
  const { xargsStdinOpaque } = peelTransparentWrappers(tokens);
  if (xargsStdinOpaque) {
    return "opaque";
  }
  if (isBareInterpreter(tokens)) {
    return "opaque";
  }
  const segment = parseSegment(command);
  if (isVariableIndirectHead(segment.head)) {
    return "opaque";
  }
  if (extractRecursiveScript(tokens)) {
    return "recursive";
  }
  return "transparent";
}
function substitutionInners(command) {
  return findCommandSubstitutions(command);
}
function redactCommand(command) {
  return command.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").replace(/sk-[A-Za-z0-9]{8,}/g, "sk-[REDACTED]").trim();
}

// src/core/v2/verdict.ts
var DEFAULT_MAX_DEPTH = 8;
var TIER0_EXTERNAL_KEYS = /* @__PURE__ */ new Set([
  "git push",
  "docker push",
  "npm publish",
  "pnpm publish",
  "terraform apply",
  "aws",
  "curl",
  "wget",
  "gh",
  "gcloud",
  "kubectl",
  "heroku",
  "vercel",
  "netlify",
  "firebase",
  "fly",
  "supabase",
  "scp",
  "ssh",
  "rsync"
]);
var TIER0_EXTERNAL_HEADS = /* @__PURE__ */ new Set([
  "dropdb",
  "createdb",
  "psql",
  "mysql",
  "mongosh",
  "redis-cli"
]);
var READ_ONLY_KEYS2 = /* @__PURE__ */ new Set([
  "cat",
  "cd",
  "echo",
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
  "which",
  "find"
]);
var LOCAL_MUTATION_KEYS = /* @__PURE__ */ new Set([
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
  "sed",
  "tee",
  "touch",
  "truncate"
]);
var LOCAL_ROUTINE_HEADS = /* @__PURE__ */ new Set([
  "tsc",
  "vitest",
  "vite",
  "webpack",
  "esbuild",
  "rollup",
  "jest",
  "mocha",
  "cargo",
  "go",
  "make",
  "cmake",
  "pnpm",
  "npm",
  "node"
]);
function worsePermission(left, right) {
  return left === "ask" || right === "ask" ? "ask" : "allow";
}
function mergeLocation(left, right) {
  if (left === right) {
    return left;
  }
  if (left === "unknown" || right === "unknown") {
    return "unknown";
  }
  if (left === "mixed" || right === "mixed") {
    return "mixed";
  }
  return "mixed";
}
function combineInternal(left, right) {
  return {
    permission: worsePermission(left.permission, right.permission),
    location: mergeLocation(left.location, right.location),
    opacity: left.opacity === "unparseable" || right.opacity === "unparseable" ? "unparseable" : left.opacity === "opaque" || right.opacity === "opaque" ? "opaque" : left.opacity === "recursive" || right.opacity === "recursive" ? "recursive" : "transparent",
    effect: left.effect === "remote_mutation" || right.effect === "remote_mutation" ? "remote_mutation" : left.effect === "unknown" || right.effect === "unknown" ? "unknown" : left.effect === "local_mutation" || right.effect === "local_mutation" ? "local_mutation" : "read_only",
    confidence: left.confidence === "deterministic" || right.confidence === "deterministic" ? "deterministic" : left.confidence,
    reason: worsePermission(left.permission, right.permission) === "ask" ? left.reason : right.reason,
    signals: [.../* @__PURE__ */ new Set([...left.signals, ...right.signals])]
  };
}
function askVerdict(params) {
  return { ...params, permission: "ask" };
}
function allowVerdict(params) {
  return { ...params, permission: "allow" };
}
function extractPathArgs(tokens) {
  const redirects = extractRedirectTargets(tokens);
  const args = [...redirects];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.startsWith("-") || token === ">" || token === ">>" || token === "<") {
      continue;
    }
    if (redirects.includes(token)) {
      continue;
    }
    args.push(token);
  }
  return args;
}
function tier0ExternalMatch(key, head, tokens) {
  if (TIER0_EXTERNAL_KEYS.has(key)) {
    return true;
  }
  if (TIER0_EXTERNAL_HEADS.has(head)) {
    return true;
  }
  if (head === "npm" && tokens[1] === "publish") {
    return true;
  }
  if (head === "docker" && tokens[1] === "push") {
    return true;
  }
  if (head === "git" && tokens[1] === "push") {
    return true;
  }
  if (head === "terraform" && tokens[1] === "apply") {
    return true;
  }
  if (head === "aws" && tokens.slice(1).join(" ").includes("s3 rm")) {
    return true;
  }
  return false;
}
function tier0HighStakesRm(tokens, context) {
  const head = tokens[0] ?? "";
  if (head !== "rm") {
    return null;
  }
  const targets = extractPathArgs(tokens);
  const analysis = analyzePathTargets({
    targets,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    trustedCwd: context.trustedCwd,
    sensitivePaths: context.sensitivePaths,
    protectedArtifactRoots: context.protectedArtifactRoots
  });
  if (!context.trustedCwd || !context.cwd) {
    return askVerdict({
      location: "unknown",
      opacity: "transparent",
      effect: "unknown",
      confidence: "deterministic",
      reason: "missing_trusted_cwd",
      signals: ["missing_trusted_cwd", ...analysis.signals]
    });
  }
  if (analysis.isHighStakes) {
    return askVerdict({
      location: analysis.location,
      opacity: "transparent",
      effect: "local_mutation",
      confidence: "deterministic",
      reason: "high_stakes_path",
      signals: ["high_stakes_path", ...analysis.signals]
    });
  }
  for (const target of targets) {
    if (target === "~" || target.startsWith("~/") || target.startsWith("/")) {
      const resolved = path11.resolve(
        target === "~" || target.startsWith("~/") ? process.env.HOME ?? "/" : context.cwd,
        target
      );
      const relative = relativeWithinRepo(context.repoRoot, resolved);
      if (relative === null) {
        return askVerdict({
          location: "repo_outside",
          opacity: "transparent",
          effect: "local_mutation",
          confidence: "deterministic",
          reason: "repo_outside_mutation",
          signals: ["repo_outside_mutation"]
        });
      }
    }
  }
  return null;
}
async function evaluateSegment(command, context, depth) {
  const maxDepth = context.maxRecursionDepth ?? DEFAULT_MAX_DEPTH;
  if (depth > maxDepth) {
    return askVerdict({
      location: "unknown",
      opacity: "opaque",
      effect: "unknown",
      confidence: "deterministic",
      reason: "recursion_depth_exceeded",
      signals: ["recursion_depth_exceeded"]
    });
  }
  const opacity = segmentOpacity(command);
  if (opacity === "unparseable") {
    return askVerdict({
      location: "unknown",
      opacity: "unparseable",
      effect: "unknown",
      confidence: "deterministic",
      reason: "unparseable_shell",
      signals: ["unparseable_shell"]
    });
  }
  for (const inner of substitutionInners(command)) {
    const innerVerdict = await evaluateSegment(inner, context, depth + 1);
    if (innerVerdict.permission === "ask") {
      return askVerdict({
        ...innerVerdict,
        opacity: "recursive",
        reason: "command_substitution",
        signals: [...innerVerdict.signals, "command_substitution"]
      });
    }
  }
  const tokens = tokenizeShell(command);
  const { tokens: peeled, xargsStdinOpaque } = peelTransparentWrappers(tokens);
  if (xargsStdinOpaque || isBareInterpreter(tokens)) {
    return askVerdict({
      location: "unknown",
      opacity: "opaque",
      effect: "unknown",
      confidence: "deterministic",
      reason: "opaque_execution",
      signals: ["opaque_execution"]
    });
  }
  const segment = parseSegment(command);
  if (isVariableIndirectHead(segment.head)) {
    return askVerdict({
      location: "unknown",
      opacity: "opaque",
      effect: "unknown",
      confidence: "deterministic",
      reason: "variable_indirect",
      signals: ["variable_indirect"]
    });
  }
  const recursiveScript = extractRecursiveScript(peeled);
  if (recursiveScript) {
    const prescan = prescanInterpreterCode(recursiveScript);
    if (prescan && tier1RequiresAsk(prescan)) {
      return askVerdict({
        location: "unknown",
        opacity: "recursive",
        effect: "unknown",
        confidence: "deterministic",
        reason: "interpreter_secret_prescan",
        signals: ["interpreter_secret_prescan"]
      });
    }
    const innerVerdict = await evaluateSegment(recursiveScript, context, depth + 1);
    return {
      ...innerVerdict,
      opacity: "recursive",
      signals: [...innerVerdict.signals, "recursive_wrapper"]
    };
  }
  if (isRoutineLauncher(peeled)) {
    const resolution = resolveLauncherRecipe({
      tokens: peeled,
      cwd: context.cwd,
      repoRoot: context.repoRoot,
      depth
    });
    if (!resolution) {
      return askVerdict({
        location: "unknown",
        opacity: "opaque",
        effect: "unknown",
        confidence: "deterministic",
        reason: "launcher_unresolved",
        signals: ["launcher_unresolved"]
      });
    }
    if (resolution.opaque || !resolution.recipe) {
      return askVerdict({
        location: "unknown",
        opacity: "opaque",
        effect: "unknown",
        confidence: "deterministic",
        reason: resolution.reason,
        signals: [resolution.reason]
      });
    }
    const innerVerdict = await evaluateSegment(resolution.recipe, context, depth + 1);
    return {
      ...innerVerdict,
      opacity: "recursive",
      signals: [...innerVerdict.signals, resolution.reason]
    };
  }
  if (tier0ExternalMatch(segment.key, segment.head, peeled)) {
    return askVerdict({
      location: "external",
      opacity: "transparent",
      effect: "remote_mutation",
      confidence: "deterministic",
      reason: "tier0_external",
      signals: ["tier0_external", segment.key]
    });
  }
  const rmVerdict = tier0HighStakesRm(peeled, context);
  if (rmVerdict) {
    return rmVerdict;
  }
  if (!context.trustedCwd || !context.cwd) {
    const hasMutation = LOCAL_MUTATION_KEYS.has(segment.key) || LOCAL_MUTATION_KEYS.has(segment.head);
    if (hasMutation || opacity === "opaque") {
      return askVerdict({
        location: "unknown",
        opacity,
        effect: "unknown",
        confidence: "deterministic",
        reason: "missing_trusted_cwd",
        signals: ["missing_trusted_cwd"]
      });
    }
  }
  let effect = "unknown";
  if (READ_ONLY_KEYS2.has(segment.key) || READ_ONLY_KEYS2.has(segment.head)) {
    effect = "read_only";
  } else if (LOCAL_MUTATION_KEYS.has(segment.key) || LOCAL_MUTATION_KEYS.has(segment.head)) {
    effect = "local_mutation";
  } else if (LOCAL_ROUTINE_HEADS.has(segment.head)) {
    effect = "local_mutation";
  }
  const pathArgs = extractPathArgs(peeled);
  const pathAnalysis = analyzePathTargets({
    targets: pathArgs,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    trustedCwd: context.trustedCwd,
    sensitivePaths: context.sensitivePaths,
    protectedArtifactRoots: context.protectedArtifactRoots
  });
  if (pathAnalysis.isHighStakes) {
    return askVerdict({
      location: pathAnalysis.location,
      opacity: "transparent",
      effect: "local_mutation",
      confidence: "deterministic",
      reason: "high_stakes_path",
      signals: pathAnalysis.signals
    });
  }
  if (pathAnalysis.location === "repo_outside" || pathAnalysis.location === "mixed") {
    const outsideEffect = effect === "read_only" ? "read_only" : effect === "unknown" ? "local_mutation" : effect;
    return askVerdict({
      location: pathAnalysis.location,
      opacity: "transparent",
      effect: outsideEffect,
      confidence: "deterministic",
      reason: "repo_outside_mutation",
      signals: ["repo_outside_mutation", ...pathAnalysis.signals]
    });
  }
  if (pathAnalysis.location === "unknown" && pathArgs.length > 0 && LOCAL_MUTATION_KEYS.has(segment.head)) {
    return askVerdict({
      location: "unknown",
      opacity: "transparent",
      effect: "unknown",
      confidence: "deterministic",
      reason: "unknown_location_mutation",
      signals: ["unknown_location_mutation"]
    });
  }
  const needsTier1 = effect === "unknown" || TIER0_EXTERNAL_HEADS.has(segment.head) || segment.head === "curl" || segment.head === "wget";
  if (needsTier1) {
    const tier1 = await context.judge.evaluate({
      command,
      innerCode: recursiveScript ?? void 0,
      head: segment.head
    });
    if (tier1RequiresAsk(tier1)) {
      return askVerdict({
        location: pathAnalysis.location === "unknown" ? "unknown" : "repo_local",
        opacity,
        effect: tier1.external_change ? "remote_mutation" : effect,
        confidence: "llm",
        reason: "tier1_catastrophic",
        signals: ["tier1_catastrophic"]
      });
    }
  }
  if (pathAnalysis.location === "repo_local" && (effect === "read_only" || effect === "local_mutation") && opacity !== "opaque") {
    return allowVerdict({
      location: "repo_local",
      opacity,
      effect,
      confidence: "assumed_repo_local",
      reason: effect === "read_only" ? "read_only" : "repo_local_mutation",
      signals: effect === "read_only" ? ["read_only"] : ["repo_local_mutation"]
    });
  }
  if (effect === "read_only") {
    return allowVerdict({
      location: pathAnalysis.location === "unknown" ? "repo_local" : pathAnalysis.location,
      opacity,
      effect: "read_only",
      confidence: "assumed_repo_local",
      reason: "read_only",
      signals: ["read_only"]
    });
  }
  return askVerdict({
    location: pathAnalysis.location,
    opacity,
    effect,
    confidence: "deterministic",
    reason: "default_ask",
    signals: ["default_ask"]
  });
}
function toVerdictResult(internal, command, context) {
  const commandRedacted = redactCommand(command);
  const relative = cwdRelative(context.repoRoot, context.cwd);
  return {
    permission: internal.permission,
    location: internal.location,
    opacity: internal.opacity,
    effect: internal.effect,
    confidence: internal.confidence,
    reason: internal.reason,
    commandRedacted,
    fingerprint: verdictFingerprint(relative, commandRedacted),
    signals: internal.signals
  };
}
async function verdict(command, context) {
  const trimmed = command.trim();
  if (!trimmed) {
    return toVerdictResult(
      allowVerdict({
        location: "repo_local",
        opacity: "transparent",
        effect: "read_only",
        confidence: "deterministic",
        reason: "empty_command",
        signals: ["empty_command"]
      }),
      trimmed,
      context
    );
  }
  const segments = splitTopLevelSegments(trimmed);
  let combined = null;
  for (const segment of segments) {
    const segmentVerdict = await evaluateSegment(segment, context, 0);
    combined = combined ? combineInternal(combined, segmentVerdict) : segmentVerdict;
  }
  return toVerdictResult(
    combined ?? askVerdict({
      location: "unknown",
      opacity: "unparseable",
      effect: "unknown",
      confidence: "deterministic",
      reason: "empty_segments",
      signals: ["empty_segments"]
    }),
    trimmed,
    context
  );
}

// src/core/v2/adapter.ts
function buildVerdictContext(params) {
  return {
    cwd: params.cwd,
    repoRoot: params.repoRoot,
    trustedCwd: params.trustedCwd ?? Boolean(params.cwd),
    sensitivePaths: params.options?.sensitivePaths ?? params.config.classifier.sensitivePaths,
    protectedArtifactRoots: params.options?.protectedArtifactRoots,
    judge: params.judge ?? (params.config.policy.modelAssist.enabled ? createOllamaJudge(params.config.policy.modelAssist.model) : createDeterministicJudgeStub()),
    mode: params.config.mode
  };
}
async function classifyShellV2(command, cwd, repoRoot, config, options = {}, judge) {
  const context = buildVerdictContext({ cwd, repoRoot, config, options, judge });
  const result = await verdict(command, context);
  return verdictToClassifyResult(result);
}
function verdictToClassifyResult(result) {
  const external = result.location === "external" || result.location === "repo_outside" || result.effect === "remote_mutation";
  const hookVerdict = result.permission === "allow" ? result.effect === "local_mutation" ? "allow_flagged" : "allow" : "deny_pending_approval";
  const legacyReason = result.reason === "repo_outside_mutation" ? result.effect === "read_only" ? "outside_repo_redirect" : "outside_repo_mutation" : result.reason === "tier0_external" ? "external_effect" : result.reason === "high_stakes_path" ? "protected_artifact" : result.reason;
  const assessment = {
    reversibility: result.effect === "read_only" ? "reversible" : result.permission === "allow" ? "recoverable_with_cost" : "irreversible",
    external,
    blastRadius: result.location,
    confidence: result.confidence === "deterministic" ? 0.95 : result.confidence === "llm" ? 0.75 : hookVerdict === "allow_flagged" ? 0.75 : 0.7,
    signals: result.signals
  };
  return {
    verdict: hookVerdict,
    reason: legacyReason,
    fingerprint: result.fingerprint,
    assessment,
    normalizedCommand: result.commandRedacted,
    summary: result.commandRedacted,
    v2: {
      location: result.location,
      opacity: result.opacity,
      effect: result.effect,
      confidence: result.confidence,
      would: result.permission,
      by: "v2",
      commandRedacted: result.commandRedacted,
      commandFingerprint: result.fingerprint,
      signals: result.signals
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
function parseAssessment(value) {
  if (!value || typeof value !== "object") {
    return void 0;
  }
  const record = value;
  if ((record.reversibility === "reversible" || record.reversibility === "recoverable_with_cost" || record.reversibility === "irreversible") && typeof record.external === "boolean" && typeof record.blastRadius === "string" && typeof record.confidence === "number" && Array.isArray(record.signals) && record.signals.every((signal) => typeof signal === "string")) {
    return {
      reversibility: record.reversibility,
      external: record.external,
      blastRadius: record.blastRadius,
      confidence: record.confidence,
      signals: record.signals
    };
  }
  return void 0;
}
function extractAgentAssessment(payload) {
  if (!payload) {
    return void 0;
  }
  for (const key of ["agentAssessment", "assessment"]) {
    const parsed = parseAssessment(payload[key]);
    if (parsed) {
      return parsed;
    }
  }
  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    return extractAgentAssessment(toolInput);
  }
  return void 0;
}
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
function applyShellPeripheralPolicy(command, action, result, options) {
  if (options.demoteL3External && result.verdict === "deny_pending_approval" && (result.reason === "external_effect" || result.assessment.external)) {
    return {
      ...result,
      verdict: "allow_flagged",
      reason: "l3_external_hint",
      assessment: {
        ...result.assessment,
        signals: [...result.assessment.signals, "l3_external_hint", "egress_boundary_expected"]
      }
    };
  }
  if (options.brokerFsScope && result.verdict === "deny_pending_approval" && (result.reason === "outside_repo_mutation" || result.reason === "outside_repo_redirect" || result.reason === "repo_outside_mutation" || result.v2?.location === "repo_outside")) {
    const outsideRepoPaths = collectOutsideRepoPaths(command, action.cwd, action.repoRoot);
    if (outsideRepoPaths.length > 0 && options.fsScopeAllowlist && allPathsAllowlisted(outsideRepoPaths, options.fsScopeAllowlist)) {
      return {
        ...result,
        verdict: "allow_flagged",
        reason: "capability_fs_hint",
        assessment: {
          ...result.assessment,
          signals: [
            ...result.assessment.signals,
            "capability_fs_hint",
            "sandbox_boundary_expected"
          ]
        }
      };
    }
  }
  return result;
}
async function classifyGatedAction(action, config, extraOptions = {}) {
  const options = { ...classifierOptionsFromConfig(config), ...extraOptions };
  if (action.kind === "shell") {
    const command = action.command ?? shellCommandFromPayload(action.payload ?? {});
    if (!command) {
      throw new GateNormalizationError("Shell gated action requires a command.");
    }
    let result = await classifyShellV2(command, action.cwd, action.repoRoot, config, options);
    result = applyShellPeripheralPolicy(command, action, result, options);
    if (!action.agentAssessment) {
      return result;
    }
    const merged = mergeAgentAssessment(result.assessment, action.agentAssessment);
    if (!merged.mismatch) {
      return { ...result, assessment: merged.assessment };
    }
    return {
      ...result,
      verdict: "deny_pending_approval",
      reason: "agent_assessment_mismatch",
      assessment: merged.assessment
    };
  }
  if (action.kind === "subagent") {
    return classifySubagent(action.payload ?? {}, action.repoRoot, options);
  }
  return classifyToolUse(action.payload ?? {}, action.repoRoot, action.cwd, options);
}
async function classifyGatedActionAsync(action, config, extraOptions = {}) {
  return classifyGatedAction(action, config, extraOptions);
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

// src/core/index.ts
init_approval();
init_config();

// src/core/control-plane-spike.ts
init_config();
import { existsSync as existsSync5 } from "node:fs";
import { mkdir as mkdir2, readFile as readFile2, rm, writeFile as writeFile2 } from "node:fs/promises";
import path12 from "node:path";
async function persistControlPlaneSpikeResult(result, env = process.env, homedir = () => env.HOME ?? "", controlPlaneDir) {
  const outputPath = path12.join(
    controlPlaneDir ?? defaultControlPlaneDir(env, homedir),
    "oq3-spike-last.json"
  );
  await mkdir2(path12.dirname(outputPath), { recursive: true });
  await writeFile2(
    outputPath,
    `${JSON.stringify({ ...result, recordedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`,
    "utf8"
  );
  return outputPath;
}
async function runControlPlaneSpike(env = process.env, cwd = process.cwd(), homedir = () => env.HOME ?? "", controlPlaneDirOverride) {
  const controlPlaneDir = controlPlaneDirOverride ?? defaultControlPlaneDir(env, homedir);
  const testFile = path12.join(controlPlaneDir, "oq3-spike.json");
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
    await mkdir2(controlPlaneDir, { recursive: true });
    await writeFile2(testFile, `${JSON.stringify(payload)}
`, "utf8");
    const readBack = await readFile2(testFile, "utf8");
    const parsed = JSON.parse(readBack.trim());
    await rm(testFile, { force: true });
    return {
      ...base,
      ok: parsed.cwd === cwd && existsSync5(controlPlaneDir),
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

// src/core/transactional/diff-evaluator.ts
import path13 from "node:path";
function categorizeChange(change, ctx) {
  const absolutePath = canonicalPath(path13.join(ctx.repoRoot, change.relativePath));
  if (!pathWithinRoot(ctx.repoRoot, absolutePath)) {
    return "repo_outside";
  }
  if (ctx.protectedRoots.some((root) => pathWithinRoot(root, absolutePath) || root === absolutePath)) {
    return "control_plane";
  }
  if (matchesSensitivePath(change.relativePath, ctx.sensitivePaths)) {
    return "sensitive_path";
  }
  return "repo_local";
}
function observedAssessment(evaluation) {
  const signals = ["transactional_observed"];
  for (const category of evaluation.categories) {
    if (category !== "repo_local") {
      signals.push(`observed_${category}`);
    }
  }
  if (evaluation.deletedCount > 0) {
    signals.push("observed_deletions");
  }
  if (evaluation.categories.includes("repo_outside") || evaluation.categories.includes("control_plane") || evaluation.categories.includes("sensitive_path")) {
    return {
      reversibility: "irreversible",
      external: evaluation.categories.includes("repo_outside"),
      blastRadius: evaluation.categories.includes("control_plane") ? "agent-belay control plane" : evaluation.categories.includes("repo_outside") ? "outside the repository" : "sensitive path",
      confidence: 1,
      signals
    };
  }
  if (evaluation.categories.includes("large_deletion")) {
    return {
      reversibility: "irreversible",
      external: false,
      blastRadius: "directory tree",
      confidence: 1,
      signals
    };
  }
  return {
    reversibility: evaluation.deletedCount > 0 ? "recoverable_with_cost" : "reversible",
    external: false,
    blastRadius: evaluation.changes.length <= 1 ? "single file" : "this repository",
    confidence: 1,
    signals
  };
}
function evaluateTransactionalDiff(changes, ctx) {
  const categories = /* @__PURE__ */ new Set();
  const deletedCount = changes.filter((change) => change.kind === "deleted").length;
  for (const change of changes) {
    categories.add(categorizeChange(change, ctx));
  }
  if (deletedCount > ctx.maxDeletionCount) {
    categories.add("large_deletion");
  }
  const categoryList = [...categories];
  const dangerous = categoryList.includes("repo_outside") || categoryList.includes("control_plane") || categoryList.includes("sensitive_path") || categoryList.includes("large_deletion");
  const base = {
    categories: categoryList,
    changes,
    deletedCount,
    verdict: dangerous ? "deny_pending_approval" : "allow",
    reason: dangerous ? "transactional_observed_risk" : "transactional_observed_safe"
  };
  return {
    ...base,
    assessment: observedAssessment(base)
  };
}

// src/core/transactional/eligibility.ts
var EXCLUDED_REASONS = /* @__PURE__ */ new Set([
  "unparseable_shell",
  "external_effect",
  "l3_external_hint",
  "custom_external",
  "external_script",
  "outside_repo_redirect",
  "outside_repo_mutation",
  "control_plane_mutation",
  "dynamic_shell_evaluation",
  "pipe_to_shell",
  "command_substitution",
  "agent_assessment_mismatch",
  "find_dangerous_action",
  "read_only",
  "custom_allow"
]);
function isTransactionalEligible(config, kind, result) {
  const transactional = config.policy.transactional;
  if (!transactional.enabled) {
    return false;
  }
  if (kind !== "shell" || !config.gates.shell || !transactional.gates.shell) {
    return false;
  }
  if (EXCLUDED_REASONS.has(result.reason)) {
    return false;
  }
  const { assessment } = result;
  if (assessment.external) {
    return false;
  }
  if (result.verdict === "deny_pending_approval") {
    return false;
  }
  if (result.verdict === "allow" && assessment.confidence >= transactional.maxConfidence) {
    return false;
  }
  const confidence = assessment.confidence;
  if (confidence < transactional.minConfidence || confidence >= transactional.maxConfidence) {
    return false;
  }
  return result.verdict === "allow_flagged";
}

// src/core/transactional/reasons.ts
var TRANSACTIONAL_ALREADY_APPLIED = "transactional_already_applied";
var TRANSACTIONAL_OBSERVED_RISK = "transactional_observed_risk";
var TRANSACTIONAL_APPLY_FAILED = "transactional_apply_failed";
var TRANSACTIONAL_APPROVAL_BYPASS_REASONS = /* @__PURE__ */ new Set([
  TRANSACTIONAL_OBSERVED_RISK,
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPLY_FAILED
]);

// src/core/transactional/git-worktree.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync6 } from "node:fs";
import { copyFile, mkdir as mkdir3, mkdtemp, rm as rm2 } from "node:fs/promises";
import os from "node:os";
import path14 from "node:path";
function execGit(repoRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `git ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`
        )
      );
    });
  });
}
async function isGitWorktreeAvailable(repoRoot) {
  try {
    await execGit(repoRoot, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}
async function isDirtyWorktree(repoRoot) {
  try {
    const status = await execGit(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
    return status.trim().length > 0;
  } catch {
    return true;
  }
}
async function createGitWorktreeSnapshot(repoRoot, stateDir) {
  const worktreePath = path14.join(stateDir, `tx-${randomUUID().replaceAll("-", "")}`);
  await mkdir3(stateDir, { recursive: true });
  await execGit(repoRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  return {
    worktreePath,
    cleanup: async () => {
      try {
        await execGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      } catch {
        await rm2(worktreePath, { recursive: true, force: true });
        try {
          await execGit(repoRoot, ["worktree", "prune"]);
        } catch {
        }
      }
    }
  };
}
function resolveWorktreeCwd(repoRoot, worktreePath, cwd) {
  const resolvedCwd = canonicalPath(cwd);
  const relative = path14.relative(canonicalPath(repoRoot), resolvedCwd);
  if (relative.startsWith("..") || path14.isAbsolute(relative)) {
    return worktreePath;
  }
  if (relative === "") {
    return worktreePath;
  }
  return path14.join(worktreePath, relative);
}
function runShellCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "ignore",
      env: process.env
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, signal: null, timedOut });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal: signal ? String(signal) : null,
        timedOut
      });
    });
  });
}
function parseStatusLine(line) {
  if (line.length < 4) {
    return null;
  }
  const status = line.slice(0, 2);
  const relativePath = line.slice(3).trim();
  if (!relativePath) {
    return null;
  }
  if (status.includes("D")) {
    return { relativePath, kind: "deleted" };
  }
  if (status === "??") {
    return { relativePath, kind: "added" };
  }
  if (status.includes("A") || status.includes("?")) {
    return { relativePath, kind: "added" };
  }
  return { relativePath, kind: "modified" };
}
async function collectWorktreeChanges(worktreePath) {
  const status = await execGit(worktreePath, ["status", "--porcelain"]);
  const changes = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of status.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const change = parseStatusLine(line);
    if (!change || seen.has(change.relativePath)) {
      continue;
    }
    seen.add(change.relativePath);
    changes.push(change);
  }
  return changes;
}
async function rollbackAppliedChanges(actions) {
  for (const action of [...actions].reverse()) {
    try {
      if (action.type === "restore") {
        await mkdir3(path14.dirname(action.target), { recursive: true });
        await copyFile(action.backupPath, action.target);
      } else {
        await rm2(action.target, { force: true });
      }
    } catch {
    }
  }
}
async function applyWorktreeChanges(worktreePath, repoRoot, changes) {
  const backupRoot = await mkdtemp(path14.join(os.tmpdir(), "belay-tx-rollback-"));
  const rollbackActions = [];
  try {
    for (const change of changes) {
      const target = path14.join(repoRoot, change.relativePath);
      if (existsSync6(target)) {
        const backupPath = path14.join(backupRoot, change.relativePath);
        await mkdir3(path14.dirname(backupPath), { recursive: true });
        await copyFile(target, backupPath);
        rollbackActions.push({ type: "restore", target, backupPath });
      } else if (change.kind !== "deleted") {
        rollbackActions.push({ type: "remove", target });
      }
      if (change.kind === "deleted") {
        await rm2(target, { force: true });
        continue;
      }
      const source = path14.join(worktreePath, change.relativePath);
      await mkdir3(path14.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  } catch (error) {
    await rollbackAppliedChanges(rollbackActions);
    throw error;
  } finally {
    await rm2(backupRoot, { recursive: true, force: true });
  }
}

// src/core/transactional/runner.ts
async function runTransactionalExecution(params) {
  const { predicted, repoRoot, stateDir, command, cwd, timeoutMs, diffContext } = params;
  if (!await isGitWorktreeAvailable(repoRoot)) {
    return {
      ok: false,
      skipped: true,
      skipReason: "git_worktree_unavailable",
      predicted,
      result: predicted
    };
  }
  if (await isDirtyWorktree(repoRoot)) {
    return {
      ok: false,
      skipped: true,
      skipReason: "dirty_worktree",
      predicted,
      result: predicted
    };
  }
  let snapshot = null;
  try {
    snapshot = await createGitWorktreeSnapshot(repoRoot, stateDir);
    const execCwd = resolveWorktreeCwd(repoRoot, snapshot.worktreePath, cwd);
    const shellResult = await runShellCommand(command, execCwd, timeoutMs);
    if (shellResult.timedOut) {
      return {
        ok: false,
        skipped: true,
        skipReason: "transactional_timed_out",
        predicted,
        result: predicted,
        commandExitCode: shellResult.exitCode,
        commandSignal: shellResult.signal,
        timedOut: true
      };
    }
    if (shellResult.exitCode !== 0 && shellResult.exitCode !== null) {
      return {
        ok: false,
        skipped: true,
        skipReason: "transactional_command_failed",
        predicted,
        result: predicted,
        commandExitCode: shellResult.exitCode,
        commandSignal: shellResult.signal
      };
    }
    const changes = await collectWorktreeChanges(snapshot.worktreePath);
    const observed = evaluateTransactionalDiff(changes, diffContext);
    if (observed.verdict === "allow") {
      try {
        await applyWorktreeChanges(snapshot.worktreePath, repoRoot, changes);
      } catch {
        const result2 = {
          ...predicted,
          verdict: "deny_pending_approval",
          reason: TRANSACTIONAL_APPLY_FAILED,
          assessment: {
            ...observed.assessment,
            reversibility: "irreversible",
            confidence: 1,
            signals: [...observed.assessment.signals, "transactional_apply_failed"]
          }
        };
        return {
          ok: true,
          predicted,
          observed,
          result: result2,
          worktreePath: snapshot.worktreePath,
          commandExitCode: shellResult.exitCode,
          commandSignal: shellResult.signal,
          timedOut: shellResult.timedOut
        };
      }
    }
    const result = {
      ...predicted,
      verdict: observed.verdict === "allow" ? "allow" : "deny_pending_approval",
      reason: observed.verdict === "allow" ? TRANSACTIONAL_ALREADY_APPLIED : TRANSACTIONAL_OBSERVED_RISK,
      assessment: observed.assessment
    };
    return {
      ok: true,
      predicted,
      observed,
      result,
      worktreePath: snapshot.worktreePath,
      commandExitCode: shellResult.exitCode,
      commandSignal: shellResult.signal,
      timedOut: shellResult.timedOut
    };
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      skipReason: error instanceof Error ? error.message : "transactional_execution_failed",
      predicted,
      result: predicted
    };
  } finally {
    if (snapshot) {
      await snapshot.cleanup();
    }
  }
}

// src/core/notify.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function notifyDeny(config, event) {
  const payload = JSON.stringify(event);
  if (config.webhookUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5e3);
      try {
        await fetch(config.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
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
          BELAY_APPROVAL_TOKEN: event.approvalToken ?? ""
        }
      });
    } catch {
    }
  }
}

// src/services/egress-service.ts
import { existsSync as existsSync7, readFileSync as readFileSync3 } from "node:fs";
import path15 from "node:path";
init_config_io();
init_config();

// src/core/egress/allowlist.ts
init_config();

// src/services/egress-service.ts
function isEgressProxyActiveForRepo(config, repoRoot, repoLocalStateDir) {
  if (!config.egress.enabled || !config.egress.demoteL3External) {
    return false;
  }
  const stateDirs = /* @__PURE__ */ new Set([
    belayStateDir(config, repoLocalStateDir),
    configuredControlPlaneDir(config)
  ]);
  const resolvedRepoRoot = path15.resolve(repoRoot);
  for (const stateDir of stateDirs) {
    const statusPath = path15.join(stateDir, "egress-proxy.json");
    if (!existsSync7(statusPath)) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync3(statusPath, "utf8"));
      if (typeof raw.pid !== "number" || !isProcessAlive(raw.pid)) {
        continue;
      }
      if (raw.repoRoot && path15.resolve(raw.repoRoot) !== resolvedRepoRoot) {
        continue;
      }
      return true;
    } catch {
    }
  }
  return false;
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/adapters/layouts/protected-paths.ts
import path16 from "node:path";
function protectedArtifactRoots(layout, repoRoot, controlPlaneDir) {
  const roots = [
    layout.configPath(repoRoot),
    layout.hooksSettingsPath(repoRoot),
    layout.hooksDir(repoRoot),
    layout.repoLocalStateDir(repoRoot),
    layout.runtimeDir(repoRoot)
  ];
  if (controlPlaneDir) {
    roots.push(controlPlaneDir);
  }
  return roots.map((entry) => path16.resolve(entry));
}

// src/adapters/shared/gate-runtime.ts
var EMPTY_APPROVALS = {
  version: 1,
  approvals: []
};
async function loadJsonFile(filePath, fallback) {
  try {
    const raw = await readFile3(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function createDefaultGateRuntimeDeps() {
  return {
    async readConfig(configPath) {
      return loadJsonFile(configPath, {});
    },
    async appendAudit(ctx, event) {
      const auditPath = path17.join(ctx.repoRoot, ctx.config.audit.logPath);
      await mkdir4(path17.dirname(auditPath), { recursive: true });
      const record = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...event };
      if (!ctx.config.audit.includeAssessment) {
        delete record.assessment;
      }
      const scrubbed = scrubValue(record, scrubOptionsFromConfig(ctx.config));
      await writeFile3(auditPath, `${JSON.stringify(scrubbed)}
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
      await mkdir4(path17.dirname(filePath), { recursive: true });
      await writeFile3(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}
`, "utf8");
    }
  };
}
async function resolveGateConfig(ctx, deps) {
  const loaded = await deps.readConfig(ctx.configPath);
  let teamConfig = null;
  const teamPath = teamConfigPath();
  if (existsSync8(teamPath)) {
    teamConfig = JSON.parse(await readFile3(teamPath, "utf8"));
  }
  return resolveLayeredConfig({
    repoConfig: loaded,
    adapterDefaults: ctx.layout.defaultConfig(ctx.repoRoot),
    teamConfig,
    teamConfigPath: teamPath,
    repoConfigPath: ctx.configPath
  }).config;
}
function runtimeClassifierOptions(ctx, config) {
  const repoLocalStateDir = ctx.layout.repoLocalStateDir(ctx.repoRoot);
  const controlPlaneDir = config.controlPlane.enabled ? resolveControlPlaneDir(config) : null;
  const brokerFsScope = isCapabilityBrokerDemotionActive(config);
  return {
    ...classifierOptionsFromConfig(config),
    demoteL3External: isEgressProxyActiveForRepo(config, ctx.repoRoot, repoLocalStateDir),
    brokerFsScope,
    fsScopeAllowlist: brokerFsScope ? loadFsScopeAllowlistSync(fsScopeAllowlistPath(config, repoLocalStateDir)) : void 0,
    protectedArtifactRoots: protectedArtifactRoots(ctx.layout, ctx.repoRoot, controlPlaneDir)
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
    approvalId: `belay_${randomUUID2().replaceAll("-", "").slice(0, 12)}`
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
      toolName: params.toolName,
      agentAssessment: extractAgentAssessment(params.payload)
    });
  } catch {
    const verdict2 = unnormalizedGateVerdict({
      reason: "normalization_failed",
      mode: ctx.config.mode,
      user_message: "agent-belay could not normalize this gated action. Run agent-belay doctor, then retry.",
      agent_message: "Belay denied this action because the hook payload could not be normalized."
    });
    await deps.appendAudit(ctx, {
      event: gateAuditEventName(params.kind),
      kind: params.kind,
      verdict: verdict2.verdict,
      reason: verdict2.reason,
      mode: ctx.config.mode,
      wouldBlock: true,
      permission: "deny"
    });
    return verdict2;
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
  const classifierOptions = runtimeClassifierOptions(ctx, ctx.config);
  const predicted = await classifyGatedActionAsync(action, ctx.config, classifierOptions);
  let result = predicted;
  let predictedAssessment;
  let observedAssessment2;
  let transactionalLayer;
  if (isTransactionalEligible(ctx.config, params.kind, predicted) && params.kind === "shell" && params.command) {
    const transactional = ctx.config.policy.transactional;
    const txResult = await runTransactionalExecution({
      command: params.command,
      cwd: params.cwd,
      repoRoot: ctx.repoRoot,
      stateDir: path17.join(ctx.layout.repoLocalStateDir(ctx.repoRoot), "transactional"),
      timeoutMs: transactional.timeoutMs,
      predicted,
      diffContext: {
        repoRoot: ctx.repoRoot,
        sensitivePaths: ctx.config.classifier.sensitivePaths,
        protectedRoots: classifierOptions.protectedArtifactRoots ?? [],
        maxDeletionCount: transactional.maxDeletionCount
      }
    });
    if (!txResult.skipped && txResult.observed) {
      result = txResult.result;
      predictedAssessment = txResult.predicted.assessment;
      observedAssessment2 = txResult.observed.assessment;
      transactionalLayer = {
        transactional: true,
        transactionalReason: txResult.observed.reason,
        transactionalCategories: txResult.observed.categories,
        transactionalChangeCount: txResult.observed.changes.length,
        transactionalTimedOut: txResult.timedOut === true
      };
    } else if (txResult.skipReason) {
      transactionalLayer = {
        transactional: false,
        transactionalSkipReason: txResult.skipReason
      };
    }
  }
  return gateDecisionToVerdict(ctx, deps, params.kind, result, {
    predictedAssessment,
    observedAssessment: observedAssessment2,
    transactionalLayer
  });
}
async function gateDecisionToVerdict(ctx, deps, kind, result, auditExtras = {}) {
  const gateBase = {
    event: gateAuditEventName(kind),
    kind,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? "",
    assessment: result.assessment,
    predictedAssessment: auditExtras.predictedAssessment,
    observedAssessment: auditExtras.observedAssessment,
    mode: ctx.config.mode,
    schemaVersion: result.v2 ? 2 : 1,
    ...result.v2 ?? {},
    ...auditExtras.transactionalLayer
  };
  if (result.reason === TRANSACTIONAL_ALREADY_APPLIED) {
    const userMessage = "Belay executed this command safely in an isolated git worktree. Observed-safe file changes are already applied; do not retry the same command.";
    const agentMessage = "Belay already applied the observed-safe effects of this shell command in isolation. Do not run it again.";
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: "allow",
      reason: result.reason,
      wouldBlock: false,
      permission: "deny"
    });
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: "deny",
      wouldBlock: false,
      user_message: userMessage,
      agent_message: agentMessage
    });
  }
  const brokerActive = isCapabilityBrokerDemotionActive(ctx.config);
  const approved = TRANSACTIONAL_APPROVAL_BYPASS_REASONS.has(result.reason) || shouldSkipBrokerApprovedOnce(brokerActive, result.reason) ? null : await consumeApprovedApproval(ctx, deps, kind, result.fingerprint);
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
  let approvalToken;
  try {
    approvalToken = await issueApprovalToken(
      {
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        repoRoot: approval.repoRoot,
        issuedAt: approval.createdAt,
        expiresAt: approval.expiresAt
      },
      configuredControlPlaneDir(ctx.config)
    );
  } catch {
    approvalToken = void 0;
  }
  if (ctx.config.notifications.webhookUrl || ctx.config.notifications.commandHook) {
    await notifyDeny(ctx.config.notifications, {
      approvalId: approval.approvalId,
      reason: result.reason,
      summary: result.normalizedCommand ?? result.summary ?? "",
      repoRoot: ctx.repoRoot,
      fingerprint: result.fingerprint,
      approvalToken
    });
  }
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
  const recorded = await recordApproval({
    approvalId,
    config: ctx.config,
    requireSignedToken: false,
    store: {
      loadPending: () => deps.loadApprovals(ctx, "pending-approvals.json"),
      loadApproved: () => deps.loadApprovals(ctx, "approved-approvals.json"),
      writePending: (filePath, state) => deps.writeApprovals(filePath, state),
      writeApproved: (filePath, state) => deps.writeApprovals(filePath, state)
    }
  });
  await deps.appendAudit(ctx, {
    event: "approval",
    kind: "approval",
    verdict: recorded.ok ? "allow" : "deny_pending_approval",
    approvalId,
    reason: recorded.ok ? "approval_recorded" : "approval_missing",
    summary: prompt
  });
  if (!recorded.ok) {
    return {
      continue: false,
      user_message: recorded.message
    };
  }
  return {
    continue: false,
    user_message: recorded.message
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
function gateVerdictToClaudePreToolUseResponse(verdict2) {
  if (verdict2.permission === "allow") {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: verdict2.user_message ?? verdict2.agent_message ?? `Belay denied this action (${verdict2.reason}).`
    }
  };
}
function gateVerdictToClaudeUserPromptResponse(verdict2) {
  if (verdict2.continue) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      continue: false,
      user_message: verdict2.user_message
    }
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
import { existsSync as existsSync9 } from "node:fs";
import path18 from "node:path";
function findRepoRoot(startPath, layout) {
  let current = path18.resolve(startPath);
  while (true) {
    for (const marker of layout.repoRootMarkers) {
      if (existsSync9(path18.join(current, marker))) {
        return current;
      }
    }
    const parent = path18.dirname(current);
    if (parent === current) {
      return path18.resolve(startPath);
    }
    current = parent;
  }
}

// src/adapters/claude/runtime-entry.ts
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
  const repoRoot = findRepoRoot(cwd, claudeLayout);
  const configPath = claudeLayout.configPath(repoRoot);
  const deps = createDefaultGateRuntimeDeps();
  const config = await resolveGateConfig({ layout: claudeLayout, repoRoot, configPath }, deps);
  return { layout: claudeLayout, repoRoot, config, configPath };
}
function mapClaudeToolName(toolName) {
  if (toolName === "Bash") {
    return "shell";
  }
  if (toolName === "Task") {
    return "subagent";
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "Delete") {
    return "tool";
  }
  return null;
}
function normalizeClaudeToolPayload(toolName, payload) {
  if (toolName === "Bash") {
    const toolInput = payload.tool_input;
    const command = toolInput && typeof toolInput === "object" ? String(toolInput.command ?? "") : "";
    return {
      tool_name: "Shell",
      tool_input: { command }
    };
  }
  if (toolName === "Edit") {
    const toolInput = payload.tool_input;
    const filePath = toolInput && typeof toolInput === "object" ? String(toolInput.file_path ?? "") : "";
    return {
      tool_name: "StrReplace",
      tool_input: { path: filePath }
    };
  }
  if (toolName === "Write") {
    const toolInput = payload.tool_input;
    const filePath = toolInput && typeof toolInput === "object" ? String(toolInput.file_path ?? "") : "";
    return {
      tool_name: "Write",
      tool_input: { path: filePath }
    };
  }
  if (toolName === "Delete") {
    const toolInput = payload.tool_input;
    const filePath = toolInput && typeof toolInput === "object" ? String(toolInput.path ?? "") : "";
    return {
      tool_name: "Delete",
      tool_input: { path: filePath }
    };
  }
  return payload;
}
async function runBeforeSubmitPromptHook() {
  try {
    const payload = await readStdinJson();
    const prompt = String(payload.prompt ?? process2.env.CLAUDE_USER_PROMPT ?? "");
    const ctx = await loadRuntimeContext(process2.cwd());
    const deps = createDefaultGateRuntimeDeps();
    await maybeRunControlPlaneSpike(ctx, deps, process2.env.BELAY_OQ3_SPIKE === "1");
    const result = await processApprovalPrompt(ctx, deps, prompt);
    jsonResponse(gateVerdictToClaudeUserPromptResponse(result));
  } catch {
    jsonResponse({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        continue: false,
        user_message: "agent-belay failed while processing approval state. Run agent-belay doctor, then retry."
      }
    });
  }
}
async function runShellGateHook() {
  try {
    const payload = await readStdinJson();
    const toolInput = payload.tool_input;
    const command = toolInput && typeof toolInput === "object" ? String(toolInput.command ?? "") : String(payload.command ?? "");
    const cwd = process2.cwd();
    const ctx = await loadRuntimeContext(cwd);
    const deps = createDefaultGateRuntimeDeps();
    const verdict2 = await evaluateGatedAction(ctx, deps, {
      kind: "shell",
      cwd,
      command,
      payload,
      toolName: "Bash"
    });
    jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict2));
  } catch {
    jsonResponse({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry."
      }
    });
  }
}
async function runToolGateHook(_eventName) {
  try {
    const payload = await readStdinJson();
    const cwd = process2.cwd();
    const ctx = await loadRuntimeContext(cwd);
    const deps = createDefaultGateRuntimeDeps();
    const toolName = String(payload.tool_name ?? "");
    const mappedKind = mapClaudeToolName(toolName);
    if (!mappedKind) {
      const verdict3 = unnormalizedGateVerdict({
        reason: "unmapped_tool",
        mode: ctx.config.mode,
        user_message: "agent-belay does not recognize this tool action. Run agent-belay doctor, then retry.",
        agent_message: "Belay denied this action because the tool could not be normalized."
      });
      jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict3));
      return;
    }
    const normalizedPayload = normalizeClaudeToolPayload(toolName, payload);
    const verdict2 = await evaluateGatedAction(ctx, deps, {
      kind: mappedKind,
      cwd,
      payload: normalizedPayload,
      toolName
    });
    jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict2));
  } catch {
    jsonResponse({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "agent-belay failed while classifying this tool action. Run agent-belay doctor, then retry."
      }
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
