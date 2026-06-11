import type { ClassifyResult } from '../types.js';
import type { PolicyEvaluationContext, PolicyEvaluationResult, PolicyRule, ShellAttributes } from './types.js';
export declare function evaluatePolicyRules(attributes: ShellAttributes, ctx: Omit<PolicyEvaluationContext, 'attributes' | 'assessment'>, rules?: PolicyRule[]): PolicyEvaluationResult;
export declare function policyResultToClassifyResult(attributes: ShellAttributes, result: PolicyEvaluationResult): ClassifyResult;
