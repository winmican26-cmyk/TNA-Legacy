import { Gate } from '../../tna-gate-api/src/gate.js';
import type { GateDecisionLike, GatePort } from '../../../packages/platform-core/src/index.js';

/**
 * Real orchestration adapter over the accepted TNA Gate (section 14) — `PlatformActionRequest ->
 * GateActionAdapter -> Authority Envelope / Decision`. Uses only Gate's own public `authorize()`
 * and `approve()` methods; no Gate behavior is modified or reimplemented, and nothing here can bypass
 * Gate by calling the execution broker directly (that only happens after this adapter returns ALLOW,
 * via `apps/tna-platform`'s separately-wired `ExecutionBroker`).
 */
export class GateActionAdapter implements GatePort {
  public constructor(private readonly gate: Gate) {}
  public authorize(principal: { readonly kind: 'agent'; readonly agentId: string }, request: {
    readonly agentId: string; readonly action: string; readonly tool: string; readonly resource: string;
    readonly estimatedCostUsd: number; readonly destination?: string; readonly approvalId?: string;
  }): GateDecisionLike {
    const decision = this.gate.authorize(principal, request);
    return {
      decisionId: decision.decisionId, decision: decision.decision, reason: decision.reason,
      policyHash: decision.policyHash, policyVersion: decision.policyVersion,
      approvalReference: decision.approvalReference, timestamp: decision.timestamp,
    };
  }
  public approve(principal: { readonly kind: 'admin' | 'approver'; readonly role: string }, request: {
    readonly agentId: string; readonly action: string; readonly tool: string; readonly resource: string;
    readonly destination?: string; readonly estimatedCostUsd: number;
    readonly approverRole: string; readonly expiresAt: string;
  }): { readonly approvalId: string; readonly expiresAt: string } {
    const { approverRole: _ar, expiresAt, ...req } = request;
    const result = this.gate.approve(principal, { request: req, expiresAt }) as { approvalId: string; expiresAt: string };
    return { approvalId: result.approvalId, expiresAt: result.expiresAt };
  }
  public requiredApproverRole(agentId: string, action: string): string | null {
    return this.gate.requiredApproverRole(agentId, action);
  }
}
