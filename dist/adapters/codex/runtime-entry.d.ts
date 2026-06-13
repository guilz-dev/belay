export declare function runBeforeSubmitPromptHook(): Promise<void>;
export declare function runToolGateHook(_eventName: string): Promise<void>;
export declare function runShellGateHook(): Promise<void>;
export declare function runAuditHook(eventName: string): Promise<void>;
