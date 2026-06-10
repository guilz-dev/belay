export declare const RUNTIME_PACKAGE_VERSION = "0.2.0";
export declare function runBeforeSubmitPromptHook(): Promise<void>;
export declare function runShellGateHook(): Promise<void>;
export declare function runToolGateHook(eventName: string): Promise<void>;
export declare function runAuditHook(eventName: string): Promise<void>;
