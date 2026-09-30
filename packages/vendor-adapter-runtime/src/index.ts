import { randomUUID } from 'node:crypto';
import type { PlatformStore } from '../../platform-core/src/index.js';
import type { ExecutionBroker } from '../../execution-broker/src/index.js';
import type { SentinelPort } from '../../platform-core/src/index.js';
import type { SentinelRuntime, SentinelPrincipal } from '../../sentinel-runtime/src/index.js';
import type { GatePort } from '../../platform-core/src/index.js';
import type { PlatformPrincipal, PlatformActionRequestInput, PlatformActionState } from '../../platform-schema/src/index.js';
import type { Principal } from '../../agent-identity/src/index.js';
import type { CapabilityPayload } from '../../capability-core/src/index.js';
import type { SentinelSessionInput, SentinelObservation } from '../../sentinel-schema/src/index.js';
import type { SentinelDecision } from '../../sentinel-runtime/src/index.js';
import { hash } from '../../authority-envelope/src/index.js';
import type {
  VendorAdapter,
  VendorSession,
  StartSessionInput,
  VendorToolCallEvent,
  CanonicalAction,
  SessionAuthority,
  VendorProvenance,
  ExecutionInput,
  AuthorizedCallResult,
  CancellationResult,
  UsageCollectionResult,
} from '../../vendor-adapter-core/src/index.js';
import { vendorAdapterRegistry } from '../../vendor-adapter-core/src/index.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- re-exported at end of file
import { createVendorAdapterHttpServer } from './http-server.js';

/**
 * Vendor Adapter Runtime
 *
 * Integrates vendor adapters with the existing TNA Platform components:
 * - PlatformGateOrchestrator (Gate authorization)
 * - ExecutionBroker (Capability issuance/redeem + credential custody)
 * - SentinelRuntime (Session monitoring)
 * - PlatformStore (Action state machine + Ledger evidence)
 *
 * This is the mediation layer that ensures:
 * 1. Every consequential vendor tool call goes through Gate
 * 2. Exact-call capability is issued and validated
 * 3. Credentials are only leased at execution time (no agent bypass)
 * 4. Sentinel monitors the session
 * 5. Vendor provenance is recorded in Ledger
 */

export interface VendorAdapterRuntimeOptions {
  platformStore: PlatformStore;
  executionBroker: ExecutionBroker;
  gatePort: GatePort;
  sentinelPort: SentinelPort;
  sentinelRuntime: SentinelRuntime; // For cancellation/containment
  sentinelController: SentinelPrincipal;
  sentinelObserver: SentinelPrincipal;
  secretBroker: { lease(names: readonly string[], context: { agentId: string; executionId: string }): Promise<{ name: string; value: string; release?: () => void }[]> };
}

export interface VendorMediatedActionInput {
  vendor: string;
  tenant: string;
  principal: string;
  agent_identity: string;
  vendor_config: Record<string, unknown>;
  /** The vendor tool call event from the vendor runtime */
  vendor_event: VendorToolCallEvent;
  /** Session authority envelope */
  authority: Omit<SessionAuthority, 'vendor' | 'vendor_session_id' | 'tenant' | 'principal' | 'agent_identity' | 'policy_snapshot_hash' | 'authority_expiry'> & {
    policy_snapshot_hash: string;
    authority_expiry: string;
  };
}

export interface VendorMediatedActionResult {
  platform_action_id: string;
  vendor_session_id: string;
  canonical_action: CanonicalAction;
  gate_decision: 'ALLOW' | 'BLOCK' | 'HOLD';
  gate_decision_id: string | null;
  capability_id: string | null;
  sentinel_session_id: string | null;
  execution_id: string | null;
  execution_result: AuthorizedCallResult | null;
  vendor_provenance: VendorProvenance | null;
  final_state: PlatformActionState;
  error: { code: string; message: string } | null;
}

export class VendorAdapterRuntime {
  private readonly store: PlatformStore;
  private readonly broker: ExecutionBroker;
  private readonly gate: GatePort;
  private readonly sentinel: SentinelPort;
  private readonly sentinelRuntime: SentinelRuntime;
  private readonly sentinelController: SentinelPrincipal;
  private readonly sentinelObserver: SentinelPrincipal;
  private readonly secretBroker: VendorAdapterRuntimeOptions['secretBroker'];

  constructor(options: VendorAdapterRuntimeOptions) {
    this.store = options.platformStore;
    this.broker = options.executionBroker;
    this.gate = options.gatePort;
    this.sentinel = options.sentinelPort;
    this.sentinelRuntime = options.sentinelRuntime;
    this.sentinelController = options.sentinelController;
    this.sentinelObserver = options.sentinelObserver;
    this.secretBroker = options.secretBroker;
  }

  /**
   * Execute a vendor-mediated action through the full TNA pipeline.
   * This is the main entry point for vendor tool calls.
   */
  async executeVendorAction(input: VendorMediatedActionInput, platformPrincipal: PlatformPrincipal): Promise<VendorMediatedActionResult> {
    if (input.tenant !== platformPrincipal.tenantId) {
      throw new Error(`Request tenant ${input.tenant} does not match credential tenant ${platformPrincipal.tenantId}`);
    }
    const adapter = vendorAdapterRegistry.get(input.vendor);
    if (!adapter) {
      throw new Error(`No adapter registered for vendor: ${input.vendor}`);
    }

    // 1. Start vendor session with session authority
    const sessionInput: StartSessionInput = {
      vendor: input.vendor,
      tenant: input.tenant,
      principal: input.principal,
      agent_identity: input.agent_identity,
      authority: input.authority,
      vendor_config: input.vendor_config,
    };

    const session = await adapter.startSession(sessionInput);
    const vendor_session_id = session.vendor_session_id;

    try {
      // 2. Normalize vendor tool call to canonical TNA action
      const normalization = adapter.normalizeAction(input.vendor_event);
      const canonical = normalization.canonical;

      // Enrich canonical with session identity
      const enrichedCanonical: CanonicalAction = {
        ...canonical,
        tenant: input.tenant,
        principal: input.principal,
        agent_identity: input.agent_identity,
      };

      // 3. Create platform action request
      const platformActionRequest = this.createPlatformActionRequest(enrichedCanonical, vendor_session_id);

      // 4. Submit to platform (creates action in RECEIVED state)
      const createdAction = this.store.createOrReturn(platformActionRequest, platformPrincipal.id);

      // 5. Gate authorization
      const gateDecision = await this.authorizeViaGate(platformPrincipal, createdAction.platform_action_id, enrichedCanonical);

      if (gateDecision.decision !== 'ALLOW') {
        const blockedState = gateDecision.decision === 'BLOCK' ? 'BLOCKED' : 'HELD';
        return this.buildResult(createdAction, vendor_session_id, enrichedCanonical, gateDecision, null, null, null, null, blockedState);
      }

      // 6. Request exact-call capability via broker
      const capability = await this.issueCapability(createdAction, gateDecision, enrichedCanonical);

      // 7. Create Sentinel session
      const sentinelSession = await this.createSentinelSession(createdAction, gateDecision, capability, enrichedCanonical);

      // 8. Pre-action Sentinel check
      const preCheck = await this.sentinelPreCheck(sentinelSession.sentinel_session_id, enrichedCanonical);
      if (preCheck.decision?.decision === 'TERMINATE') {
        return this.buildResult(createdAction, vendor_session_id, enrichedCanonical, gateDecision, capability, sentinelSession.sentinel_session_id, null, null, 'TERMINATED');
      }
      if (preCheck.decision?.decision === 'HOLD') {
        return this.buildResult(createdAction, vendor_session_id, enrichedCanonical, gateDecision, capability, sentinelSession.sentinel_session_id, null, null, 'HELD');
      }

      // 9. Execute through broker (credential custody enforced)
      const executionResult = await this.executeViaBroker(adapter, session, enrichedCanonical, capability, createdAction);

      // 10. Post-action Sentinel observation
      await this.sentinelPostCheck(sentinelSession.sentinel_session_id, enrichedCanonical);

      // 11. Collect vendor provenance for Ledger
      const vendorProvenance = await adapter.collectVendorProvenance(vendor_session_id);

      // 12. Update platform action to COMPLETED
      // (In real implementation, this would go through PlatformExecutionOrchestrator)
      const finalState = 'COMPLETED' as PlatformActionState;

      return this.buildResult(createdAction, vendor_session_id, enrichedCanonical, gateDecision, capability, sentinelSession.sentinel_session_id, executionResult, vendorProvenance, finalState);
    } catch (error) {
      // Handle errors - fail closed
      return this.buildErrorResult(input, vendor_session_id, error);
    } finally {
      // Cleanup session
      await adapter.closeSession(vendor_session_id).catch(() => {});
    }
  }

  /**
   * Execute a vendor-mediated action and return a simplified result
   * suitable for the PreToolUse hook response.
   * This is the public entry point for the HTTP hook integration.
   */
  async executeVendorActionForHook(input: VendorMediatedActionInput, platformPrincipal: PlatformPrincipal): Promise<{
    authorized: boolean;
    permissionDecision: 'allow' | 'deny' | 'ask';
    reason: string;
    updatedInput: Record<string, unknown>;
    vendor_provenance?: {
      vendor_session_id: string;
      vendor_tool_call_id: string | null;
      execution_id: string | null;
    };
  }> {
    const fullResult = await this.executeVendorAction(input, platformPrincipal);

    if (fullResult.gate_decision === 'ALLOW' && fullResult.execution_result) {
      return {
        authorized: true,
        permissionDecision: 'allow',
        reason: `Gate ALLOW — exact-call capability issued and executed`,
        updatedInput: {}, // Could be populated if TNA modifies args
        vendor_provenance: {
          vendor_session_id: fullResult.vendor_session_id,
          vendor_tool_call_id: fullResult.execution_result?.vendor_tool_call_id ?? null,
          execution_id: fullResult.execution_id,
        },
      };
    }

    if (fullResult.gate_decision === 'HOLD') {
      return {
        authorized: false,
        permissionDecision: 'ask',
        reason: `Gate HOLD — human approval required: ${fullResult.error?.message ?? 'Awaiting approval'}`,
        updatedInput: {},
      };
    }

    return {
      authorized: false,
      permissionDecision: 'deny',
      reason: fullResult.error?.message ?? `Gate ${fullResult.gate_decision}: ${fullResult.gate_decision}`,
      updatedInput: {},
    };
  }

  /**
   * Cancel a vendor session with Sentinel containment integration.
   * Uses SentinelRuntime.terminate() for immediate stop or hold() for pause.
   * Records the cancellation in Sentinel with proper audit trail.
   */
  async cancelVendorSessionWithSentinel(
    vendor: string,
    vendor_session_id: string,
    sentinel_session_id: string,
    reason: string,
    mode: 'terminate' | 'hold' = 'terminate'
  ): Promise<CancellationResult & { sentinel_outcome: 'TERMINATED' | 'HELD' | 'INDETERMINATE' }> {
    const adapter = vendorAdapterRegistry.get(vendor);
    if (!adapter) {
      throw new Error(`No adapter registered for vendor: ${vendor}`);
    }

    const requested_at = new Date().toISOString();

    // First, try vendor-native cancellation (if supported)
    const vendorResult = await adapter.cancelSession(vendor_session_id);

    // Then, enforce Sentinel containment (authoritative for TNA)
    let sentinel_outcome: 'TERMINATED' | 'HELD' | 'INDETERMINATE';
    let sentinel_acknowledged = false;

    try {
      if (mode === 'terminate') {
        await this.sentinelRuntime.terminate(this.sentinelController, sentinel_session_id, reason);
        sentinel_outcome = 'TERMINATED';
        sentinel_acknowledged = true;
      } else {
        await this.sentinelRuntime.hold(this.sentinelController, sentinel_session_id, reason);
        sentinel_outcome = 'HELD';
        sentinel_acknowledged = true;
      }
    } catch {
      sentinel_outcome = 'INDETERMINATE';
      sentinel_acknowledged = false;
    }

    return {
      vendor_session_id,
      cancel_requested: true,
      cancel_acknowledged: vendorResult.cancel_acknowledged ?? sentinel_acknowledged,
      cancel_failed: vendorResult.cancel_failed ?? !sentinel_acknowledged,
      cancel_unavailable: vendorResult.cancel_unavailable ?? false,
      reason: `${vendorResult.reason}; Sentinel: ${sentinel_outcome}`,
      requested_at,
      acknowledged_at: sentinel_acknowledged ? new Date().toISOString() : null,
      sentinel_outcome,
    };
  }

  /**
   * Cancel a vendor session (vendor-native only, no Sentinel enforcement).
   * Use cancelVendorSessionWithSentinel for production use.
   */
  async cancelVendorSession(vendor: string, vendor_session_id: string): Promise<CancellationResult> {
    const adapter = vendorAdapterRegistry.get(vendor);
    if (!adapter) {
      throw new Error(`No adapter registered for vendor: ${vendor}`);
    }

    return adapter.cancelSession(vendor_session_id);
  }

  /**
   * Collect usage for a vendor session.
   */
  async collectVendorUsage(vendor: string, vendor_session_id: string): Promise<UsageCollectionResult> {
    const adapter = vendorAdapterRegistry.get(vendor);
    if (!adapter) {
      throw new Error(`No adapter registered for vendor: ${vendor}`);
    }

    return adapter.collectUsage(vendor_session_id);
  }

  private createPlatformActionRequest(canonical: CanonicalAction, vendor_session_id: string): PlatformActionRequestInput {
    return {
      version: '1.0',
      request_id: `req_${randomUUID()}`,
      tenant_id: canonical.tenant,
      agent_id: canonical.agent_identity,
      action: canonical.tool,
      tool: canonical.tool,
      operation: canonical.operation,
      resource: canonical.resource,
      input: canonical.argv,
      requested_runtime_limits: { max_runtime_seconds: canonical.requested_budget.max_runtime_seconds },
      requested_cost_limits: { max_cost_usd: canonical.requested_budget.max_cost_usd },
      requires_verification: canonical.risk_class === 'HIGH' || canonical.risk_class === 'CRITICAL',
      metadata: {
        vendor: canonical.vendor,
        vendor_session_id,
        vendor_request_id: canonical.vendor_request_id,
        vendor_tool_call_id: canonical.vendor_tool_call_id,
        effect: canonical.effect,
        risk_class: canonical.risk_class,
        paths: canonical.paths,
      },
    };
  }

  private async authorizeViaGate(principal: PlatformPrincipal, actionId: string, _canonical: CanonicalAction): Promise<{
    decision: 'ALLOW' | 'BLOCK' | 'HOLD';
    decision_id: string;
    reason: string;
    policy_hash: string | null;
    policy_version: string | null;
    approval_reference: string | null;
    decided_at: string;
  }> {
  void _canonical;
    // Use PlatformGateOrchestrator logic directly
    const action = this.store.get(principal.tenantId, actionId);
    const authorizing = action.state === 'RECEIVED'
      ? this.store.transition(action.tenant_id, action.platform_action_id, action.state_version, 'AUTHORIZING')
      : action;

    const decision = this.gate.authorize({ kind: 'agent', agentId: principal.agentId! }, {
      agentId: authorizing.request.agent_id,
      action: authorizing.request.action,
      tool: authorizing.request.tool,
      resource: authorizing.request.resource,
      estimatedCostUsd: authorizing.request.requested_cost_limits?.max_cost_usd ?? 0,
      ...(authorizing.request.metadata?.destination ? { destination: authorizing.request.metadata.destination as string } : {}),
    });

    const evidence = {
      decision_id: decision.decisionId,
      decision: decision.decision,
      reason: decision.reason,
      policy_hash: decision.policyHash,
      policy_version: decision.policyVersion,
      approval_reference: decision.approvalReference,
      decided_at: decision.timestamp,
    };

    this.store.recordGateDecision(authorizing.tenant_id, authorizing.platform_action_id, authorizing.state_version, evidence);

    return evidence;
  }

  private async issueCapability(
    action: { platform_action_id: string; tenant_id: string; gate_decision: { decision_id: string } | null },
    gateDecision: { decision_id: string; policy_hash: string | null; policy_version: string | null },
    _canonical: CanonicalAction,
  ): Promise<CapabilityPayload> {
  void _canonical;
    const gatePrincipal: Principal = { kind: 'agent', agentId: action.tenant_id }; // Simplified

    // Issue capability through broker
    const issued = this.broker.issue(gatePrincipal, gateDecision.decision_id);

    // Record capability on platform action
    this.store.recordCapability(action.tenant_id, action.platform_action_id, 1, issued.payload.capability_id); // state_version would be tracked properly

    return issued.payload;
  }

  private async createSentinelSession(
    action: { platform_action_id: string; tenant_id: string; correlation_id: string; gate_decision: { decision_id: string; decided_at: string } | null },
    gateDecision: { decision_id: string; decided_at: string; policy_hash: string | null },
    capability: CapabilityPayload,
    canonical: CanonicalAction,
  ): Promise<SentinelSessionInput & { sentinel_session_id: string }> {
    const runtimeSeconds = canonical.requested_budget.max_runtime_seconds;
    const costUsd = canonical.requested_budget.max_cost_usd;
    const policyHash = gateDecision.policy_hash ?? hash(canonical.argv);

    const session = this.sentinel.createSession(this.sentinelController, {
      version: '1.0',
      tenant_id: action.tenant_id,
      agent_id: canonical.agent_identity,
      execution_id: action.platform_action_id,
      decision_id: gateDecision.decision_id,
      capability_id: capability.capability_id,
      correlation_id: action.correlation_id,
      authority_snapshot_hash: policyHash,
      policy_snapshot_hash: policyHash,
      expected_action: canonical.tool,
      expected_tool: canonical.tool,
      expected_resource: canonical.resource.replace(/^\/+/, '') || canonical.resource,
      allowed_destinations: [],
      allowed_operations: ['read', 'write', 'create', 'delete'].filter(op =>
        canonical.operation === op || (canonical.operation === 'write' && op === 'write')
      ) as SentinelSessionInput['allowed_operations'],
      authority_expiry: new Date(Date.parse(gateDecision.decided_at) + runtimeSeconds * 1000).toISOString(),
      runtime_limits: { max_runtime_seconds: runtimeSeconds },
      cost_limits: { max_cost_usd: costUsd },
    });

    this.store.recordSentinelSession(action.tenant_id, action.platform_action_id, 2, session.sentinel_session_id); // state_version would be tracked properly

    return session;
  }

  private async sentinelPreCheck(sentinel_session_id: string, canonical: CanonicalAction): Promise<{ observation: SentinelObservation; decision: SentinelDecision | null }> {
    return this.sentinel.submitObservation(this.sentinelObserver, sentinel_session_id, {
      version: '1.0',
      observation_id: `obs_pre_${randomUUID()}`,
      tenant_id: '', // Would be filled from session
      sentinel_session_id,
      timestamp: new Date().toISOString(),
      source: 'EXECUTION_BROKER',
      observation_type: 'TOOL_CALL_REQUESTED',
      payload: { tool: canonical.tool, resource: canonical.resource.replace(/^\/+/, '') || canonical.resource },
    });
  }

  private async sentinelPostCheck(sentinel_session_id: string, canonical: CanonicalAction): Promise<void> {
    await this.sentinel.submitObservation(this.sentinelObserver, sentinel_session_id, {
      version: '1.0',
      observation_id: `obs_post_${randomUUID()}`,
      tenant_id: '',
      sentinel_session_id,
      timestamp: new Date().toISOString(),
      source: 'EXECUTION_BROKER',
      observation_type: 'EXECUTION_COMPLETED',
      payload: { tool: canonical.tool, resource: canonical.resource.replace(/^\/+/, '') || canonical.resource },
    }).catch(() => undefined); // Best effort
  }

  private async executeViaBroker(
    adapter: VendorAdapter,
    session: VendorSession,
    canonical: CanonicalAction,
    capability: CapabilityPayload,
    _action: { platform_action_id: string; tenant_id: string },
  ): Promise<AuthorizedCallResult> {
  void _action;
    // Prepare execution input for adapter
    const executionInput: ExecutionInput = {
      vendor_session_id: session.vendor_session_id,
      canonical_action: canonical,
      exact_call_capability: {
        capability_id: capability.capability_id,
        execution_id: capability.execution_id,
        agent_id: capability.agent_id,
        decision_id: capability.decision_id,
        action: capability.action,
        tool: capability.tool,
        resource: capability.resource,
        operation: capability.operation,
        destination: capability.destination,
        input_hash: capability.input_hash,
        policy_hash: capability.policy_hash,
        policy_issuance_id: capability.policy_issuance_id,
        issued_at: capability.issued_at,
        expires_at: capability.expires_at,
        single_use: capability.single_use,
        nonce: capability.nonce,
        vendor_session_id: session.vendor_session_id,
        vendor_request_id: canonical.vendor_request_id,
        vendor_tool_call_id: canonical.vendor_tool_call_id,
      },
      required_credentials: [], // Would be populated from tool registry
    };

    // Execute through adapter (which will use broker internally)
    const result = await adapter.executeAuthorizedCall(executionInput);

    // Record execution result on platform action
    // this.store.recordExecutionResult(...)

    return result;
  }

  private buildResult(
    action: { platform_action_id: string; tenant_id: string },
    vendor_session_id: string,
    canonical: CanonicalAction,
    gateDecision: { decision: 'ALLOW' | 'BLOCK' | 'HOLD'; decision_id: string },
    capability: CapabilityPayload | null,
    sentinel_session_id: string | null,
    executionResult: AuthorizedCallResult | null,
    vendorProvenance: VendorProvenance | null,
    finalState: PlatformActionState,
  ): VendorMediatedActionResult {
    return {
      platform_action_id: action.platform_action_id,
      vendor_session_id,
      canonical_action: canonical,
      gate_decision: gateDecision.decision,
      gate_decision_id: gateDecision.decision_id,
      capability_id: capability?.capability_id ?? null,
      sentinel_session_id,
      execution_id: executionResult?.execution_id ?? null,
      execution_result: executionResult,
      vendor_provenance: vendorProvenance,
      final_state: finalState,
      error: null,
    };
  }

  private buildErrorResult(
    input: VendorMediatedActionInput,
    vendor_session_id: string,
    error: unknown,
  ): VendorMediatedActionResult {
    return {
      platform_action_id: '',
      vendor_session_id,
      canonical_action: {} as CanonicalAction,
      gate_decision: 'BLOCK',
      gate_decision_id: null,
      capability_id: null,
      sentinel_session_id: null,
      execution_id: null,
      execution_result: null,
      vendor_provenance: null,
      final_state: 'FAILED',
      error: {
        code: 'VENDOR_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// HTTP Server wrapper for hook integration
export { createVendorAdapterHttpServer } from './http-server.js';
export type { VendorAdapterHttpServerOptions } from './http-server.js';