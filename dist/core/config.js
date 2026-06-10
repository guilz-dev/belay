export const DEFAULT_CONFIG_V2 = {
    version: 2,
    mode: 'enforce',
    approvalTtlMinutes: 15,
    tokenPrefix: '/belay-approve',
    gates: {
        shell: true,
        subagent: true,
        fileMutation: true,
        toolShell: true,
    },
    classifier: {
        // When true, scan every chained segment and keep the strictest verdict.
        // When false, return immediately on the first deny segment.
        strictChains: true,
        customExternalCommands: [],
        customAllowCommands: [],
        sensitivePaths: ['.env', '.env.*', '**/credentials/**'],
    },
    audit: {
        logPath: '.cursor/belay/audit.ndjson',
        includeAssessment: true,
    },
};
export function isConfigV1(value) {
    return typeof value === 'object' && value !== null && value.version === 1;
}
export function migrateConfig(loaded) {
    if (typeof loaded !== 'object' || loaded === null) {
        return { ...DEFAULT_CONFIG_V2 };
    }
    const raw = loaded;
    const base = { ...DEFAULT_CONFIG_V2 };
    if (raw.version === 1 || raw.version === undefined) {
        return normalizeConfig({
            ...base,
            mode: raw.mode ?? base.mode,
            approvalTtlMinutes: raw.approvalTtlMinutes ?? base.approvalTtlMinutes,
            tokenPrefix: raw.tokenPrefix ?? base.tokenPrefix,
            gates: {
                ...base.gates,
                shell: raw.gates?.shell ?? base.gates.shell,
                subagent: raw.gates?.subagent ?? base.gates.subagent,
            },
            audit: {
                ...base.audit,
                logPath: raw.audit?.logPath ?? base.audit.logPath,
            },
        });
    }
    return normalizeConfig({
        ...base,
        ...raw,
        version: 2,
        gates: {
            ...base.gates,
            ...(raw.gates ?? {}),
        },
        classifier: {
            ...base.classifier,
            ...(raw.classifier ?? {}),
        },
        audit: {
            ...base.audit,
            ...(raw.audit ?? {}),
        },
    });
}
export function normalizeConfig(config) {
    return {
        version: 2,
        mode: config.mode === 'audit' ? 'audit' : 'enforce',
        approvalTtlMinutes: typeof config.approvalTtlMinutes === 'number' && config.approvalTtlMinutes > 0
            ? config.approvalTtlMinutes
            : DEFAULT_CONFIG_V2.approvalTtlMinutes,
        tokenPrefix: config.tokenPrefix || DEFAULT_CONFIG_V2.tokenPrefix,
        gates: {
            shell: config.gates.shell !== false,
            subagent: config.gates.subagent !== false,
            fileMutation: config.gates.fileMutation !== false,
            toolShell: config.gates.toolShell !== false,
        },
        classifier: {
            strictChains: config.classifier?.strictChains !== false,
            customExternalCommands: Array.isArray(config.classifier?.customExternalCommands)
                ? config.classifier.customExternalCommands
                : [],
            customAllowCommands: Array.isArray(config.classifier?.customAllowCommands)
                ? config.classifier.customAllowCommands
                : [],
            sensitivePaths: Array.isArray(config.classifier?.sensitivePaths)
                ? config.classifier.sensitivePaths
                : DEFAULT_CONFIG_V2.classifier.sensitivePaths,
        },
        audit: {
            logPath: config.audit?.logPath || DEFAULT_CONFIG_V2.audit.logPath,
            includeAssessment: config.audit?.includeAssessment !== false,
        },
    };
}
export function mergeConfig(existing, defaults = DEFAULT_CONFIG_V2) {
    const migrated = migrateConfig(existing);
    return normalizeConfig({
        ...defaults,
        ...migrated,
        gates: {
            ...defaults.gates,
            ...migrated.gates,
        },
        classifier: {
            ...defaults.classifier,
            ...migrated.classifier,
        },
        audit: {
            ...defaults.audit,
            ...migrated.audit,
        },
    });
}
export function classifierOptionsFromConfig(config) {
    return {
        strictChains: config.classifier.strictChains,
        customExternalCommands: config.classifier.customExternalCommands,
        customAllowCommands: config.classifier.customAllowCommands,
        sensitivePaths: config.classifier.sensitivePaths,
    };
}
