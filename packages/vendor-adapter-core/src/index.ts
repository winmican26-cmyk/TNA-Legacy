import { createHash } from 'node:crypto';

/**
 * TNA VENDOR AUTHORITY ADAPTER v0.1
 *
 * Vendor-neutral adapter contract for placing real external AI-agent runtimes
 * behind TNA such that consequential tool actions cannot execute without
 * a real TNA Gate decision and exact-call capability.
 *
 * Architectural invariant:
 * A MODEL MAY PROPOSE AN ACTION.
 * IT MUST NOT POSSESS AN ALTERNATE PATH THAT CAN PRODUCE THE SAME CONSEQUENTIAL EFFECT OUTSIDE THE GOVERNED EXECUTION BOUNDARY.
 */

// ============================================================
// Canonical Action Normalization (Section 4)
// ============================================================

/** Risk classification for normalized actions. */
export type RiskClass = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Effect classification for draft vs commit semantics (Section 11). */
export type EffectClass = 'DRAFT' | 'PREVIEW' | 'GENERATE' | 'COMMIT' | 'SEND' | 'POST' | 'PAY' | 'PUSH' | 'DEPLOY' | 'DELETE';

/**
 * Canonical normalized TNA action form.
 * Policy MUST operate on this semantic data, not arbitrary vendor JSON.
 * Equivalent actions from different vendors produce equivalent TNA policy semantics.
 */
export interface CanonicalAction {
  /** Vendor identification */
  vendor: string;
  vendor_session_id: string;
  vendor_request_id: string;
  vendor_tool_call_id: string | null;

  /** Tenant/principal/agent identity */
  tenant: string;
  principal: string;
  agent_identity: string;

  /** Action semantics */
  tool: string;
  operation: string;
  resource: string;
  destination: string | null;
  argv: Record<string, unknown>;
  paths: readonly string[];
  effect: EffectClass;

  /** Risk and budget */
  risk_class: RiskClass;
  input_hash: string;
  requested_budget: { max_cost_usd: number; max_runtime_seconds: number };

  /** Vendor-specific raw request retained as provenance (not for policy evaluation) */
  vendor_raw_request: Record<string, unknown>;
}

/** Input to normalization: vendor-specific tool call event. */
export interface VendorToolCallEvent {
  vendor: string;
  vendor_session_id: string;
  vendor_request_id: string;
  vendor_tool_call_id: string | null;
  vendor_tool_name: string;
  vendor_tool_arguments: Record<string, unknown>;
  vendor_model?: string;
  vendor_model_version?: string;
  vendor_usage?: VendorUsage;
  raw_event: Record<string, unknown>;
}

/** Usage metadata from vendor (Section 13). */
export interface VendorUsage {
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  vendor_request_id: string | null;
  vendor_reported_cost_usd: number | null;
  cost_type: 'measured' | 'estimated' | 'unknown' | 'unavailable';
}

/** Normalization result. */
export interface NormalizationResult {
  canonical: CanonicalAction;
  warnings: readonly string[];
}

/**
 * Normalizes a vendor-specific tool call into canonical TNA action form.
 * This is the single point where vendor semantics map to TNA policy semantics.
 */
export interface ActionNormalizer {
  normalize(event: VendorToolCallEvent): NormalizationResult;
  classifyEffect(tool: string, operation: string, argv: Record<string, unknown>): EffectClass;
  classifyRisk(canonical: CanonicalAction): RiskClass;
}

// ============================================================
// Session Authority vs Exact-Call Capability (Section 5)
// ============================================================

/**
 * Session Authority: broad maximum authority available during one agent run.
 * Does NOT authorize arbitrary execution — only defines the envelope.
 */
export interface SessionAuthority {
  vendor: string;
  vendor_session_id: string;
  tenant: string;
  principal: string;
  agent_identity: string;
  allowed_tools: readonly string[];
  allowed_resources: readonly string[];
  allowed_operations: readonly string[];
  allowed_destinations: readonly string[];
  max_budget_usd: number;
  max_runtime_seconds: number;
  authority_expiry: string; // ISO timestamp
  policy_snapshot_hash: string;
}

/**
 * Exact-Call Capability: bounded capability tied to ONE real action.
 * The agent cannot obtain approval for deploy(commit=A) and substitute deploy(commit=B).
 */
export interface ExactCallCapability {
  capability_id: string;
  execution_id: string;
  agent_id: string;
  decision_id: string;
  action: string;
  tool: string;
  resource: string;
  operation: string;
  destination: string | null;
  input_hash: string;
  policy_hash: string;
  policy_issuance_id: string;
  issued_at: string;
  expires_at: string;
  single_use: true;
  nonce: string;
  /** Vendor correlation for audit trail */
  vendor_session_id: string;
  vendor_request_id: string;
  vendor_tool_call_id: string | null;
}

/** Capability issuance request from adapter to broker. */
export interface CapabilityIssuanceRequest {
  session_authority: SessionAuthority;
  canonical_action: CanonicalAction;
  gate_decision_id: string;
  gate_policy_hash: string | null;
  gate_policy_version: string | null;
}

// ============================================================
// Vendor Adapter Contract (Section 3)
// ============================================================

/** Adapter lifecycle state. */
export type AdapterSessionState = 'CREATED' | 'ACTIVE' | 'CANCELLING' | 'CANCELLED' | 'COMPLETED' | 'FAILED';

/** Session metadata returned from startSession. */
export interface VendorSession {
  vendor_session_id: string;
  vendor: string;
  tenant: string;
  principal: string;
  agent_identity: string;
  state: AdapterSessionState;
  created_at: string;
  authority: SessionAuthority;
  /** Vendor-specific session handle (opaque to TNA) */
  vendor_handle: unknown;
}

/** Result of authorized call execution. */
export interface AuthorizedCallResult {
  execution_id: string;
  vendor_tool_call_id: string | null;
  result: unknown;
  result_hash: string;
  usage: VendorUsage | null;
  vendor_provenance: VendorProvenance;
  completed_at: string;
}

/** Vendor provenance for Ledger (Section 9). */
export interface VendorProvenance {
  vendor: string;
  vendor_session_id: string;
  vendor_request_id: string;
  vendor_tool_call_id: string | null;
  model_identifier: string | null;
  model_snapshot: string | null;
  normalized_action_hash: string;
  capability_id: string;
  execution_id: string;
}

/** Cancellation result (Section 10). */
export interface CancellationResult {
  vendor_session_id: string;
  cancel_requested: boolean;
  cancel_acknowledged: boolean | null;
  cancel_failed: boolean | null;
  cancel_unavailable: boolean | null;
  reason: string;
  requested_at: string;
  acknowledged_at: string | null;
}

/** Usage collection result. */
export interface UsageCollectionResult {
  vendor_session_id: string;
  total_usage: VendorUsage;
  per_request_usage: readonly VendorUsage[];
  collected_at: string;
}

/**
 * VENDOR-NEUTRAL ADAPTER CONTRACT
 *
 * Primary responsibility: translation and lifecycle mediation.
 * TNA remains authoritative for authorization.
 * Do not force methods that existing architecture already provides elsewhere.
 */
export interface VendorAdapter {
  /** Start a new vendor session with session authority envelope. */
  startSession(input: StartSessionInput): Promise<VendorSession>;

  /** Normalize a vendor tool call event to canonical TNA action. */
  normalizeAction(event: VendorToolCallEvent): NormalizationResult;

  /** Request Gate authorization and exact-call capability for a normalized action. */
  requestAuthorization(input: AuthorizationRequestInput): Promise<AuthorizationResult>;

  /** Execute the authorized call through the broker (credential custody enforced). */
  executeAuthorizedCall(input: ExecutionInput): Promise<AuthorizedCallResult>;

  /** Cancel the vendor session (where vendor runtime supports it). */
  cancelSession(vendor_session_id: string): Promise<CancellationResult>;

  /** Collect usage telemetry for the session. */
  collectUsage(vendor_session_id: string): Promise<UsageCollectionResult>;

  /** Collect vendor provenance for Ledger correlation. */
  collectVendorProvenance(vendor_session_id: string): Promise<VendorProvenance>;

  /** Close session and release resources. */
  closeSession(vendor_session_id: string): Promise<void>;
}

/** Input to startSession. */
export interface StartSessionInput {
  vendor: string;
  tenant: string;
  principal: string;
  agent_identity: string;
  /** Session authority envelope — broad maximums for this run. */
  authority: Omit<SessionAuthority, 'vendor' | 'vendor_session_id' | 'tenant' | 'principal' | 'agent_identity' | 'policy_snapshot_hash' | 'authority_expiry'> & {
    policy_snapshot_hash: string;
    authority_expiry: string;
  };
  /** Vendor-specific configuration (model, API credentials, etc.) */
  vendor_config: Record<string, unknown>;
}

/** Input to requestAuthorization. */
export interface AuthorizationRequestInput {
  vendor_session_id: string;
  canonical_action: CanonicalAction;
  /** Gate decision from PlatformGateOrchestrator. */
  gate_decision: {
    decision_id: string;
    decision: 'ALLOW' | 'BLOCK' | 'HOLD';
    reason: string;
    policy_hash: string | null;
    policy_version: string | null;
    approval_reference: string | null;
    decided_at: string;
  };
}

/** Result of requestAuthorization. */
export interface AuthorizationResult {
  authorized: boolean;
  session_authority: SessionAuthority;
  exact_call_capability: ExactCallCapability | null;
  /** If BLOCK/HOLD or capability issuance failed. */
  error_code: string | null;
  error_message: string | null;
}

/** Input to executeAuthorizedCall. */
export interface ExecutionInput {
  vendor_session_id: string;
  canonical_action: CanonicalAction;
  exact_call_capability: ExactCallCapability;
  /** Secret broker will lease credentials for this execution only. */
  required_credentials: readonly string[];
}

// ============================================================
// Adapter Registry
// ============================================================

/** Registry for vendor adapters. */
export class VendorAdapterRegistry {
  private readonly adapters = new Map<string, VendorAdapter>();

  register(vendor: string, adapter: VendorAdapter): void {
    if (this.adapters.has(vendor)) {
      throw new Error(`Adapter already registered for vendor: ${vendor}`);
    }
    this.adapters.set(vendor, adapter);
  }

  get(vendor: string): VendorAdapter | null {
    return this.adapters.get(vendor) ?? null;
  }

  list(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }

  has(vendor: string): boolean {
    return this.adapters.has(vendor);
  }
}

/** Global registry instance. */
export const vendorAdapterRegistry = new VendorAdapterRegistry();

// ============================================================
// Canonical Action Hash (for Ledger correlation)
// ============================================================

/** Computes deterministic hash of canonical action for Ledger correlation. */
export function computeCanonicalActionHash(canonical: CanonicalAction): string {
  const hashInput = {
    vendor: canonical.vendor,
    vendor_session_id: canonical.vendor_session_id,
    vendor_request_id: canonical.vendor_request_id,
    vendor_tool_call_id: canonical.vendor_tool_call_id,
    tenant: canonical.tenant,
    principal: canonical.principal,
    agent_identity: canonical.agent_identity,
    tool: canonical.tool,
    operation: canonical.operation,
    resource: canonical.resource,
    destination: canonical.destination,
    argv: canonical.argv,
    paths: canonical.paths,
    effect: canonical.effect,
    risk_class: canonical.risk_class,
    input_hash: canonical.input_hash,
    requested_budget: canonical.requested_budget,
  };
  return createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
}

// ============================================================
// Error Types
// ============================================================

export class VendorAdapterError extends Error {
  constructor(
    public readonly code:
      | 'VENDOR_UNSUPPORTED'
      | 'SESSION_NOT_FOUND'
      | 'SESSION_ALREADY_EXISTS'
      | 'INVALID_VENDOR_EVENT'
      | 'NORMALIZATION_FAILED'
      | 'AUTHORIZATION_FAILED'
      | 'CAPABILITY_ISSUANCE_FAILED'
      | 'EXECUTION_FAILED'
      | 'CANCELLATION_UNAVAILABLE'
      | 'CANCELLATION_FAILED'
      | 'CREDENTIAL_UNAVAILABLE'
      | 'GATE_UNAVAILABLE'
      | 'FAIL_CLOSED',
    message: string,
    public readonly vendor_session_id?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'VendorAdapterError';
  }
}

// ============================================================
// Stub Adapters for Future Vendors (Section 17)
// ============================================================

/** Base class for NOT_IMPLEMENTED adapters. */
export abstract class NotImplementedAdapter implements VendorAdapter {
  protected readonly vendor: string;

  constructor(vendor: string) {
    this.vendor = vendor;
  }

  async startSession(): Promise<VendorSession> {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }

  normalizeAction(): NormalizationResult {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }

  async requestAuthorization(): Promise<AuthorizationResult> {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }

  async executeAuthorizedCall(): Promise<AuthorizedCallResult> {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }

  async cancelSession(): Promise<CancellationResult> {
    return {
      vendor_session_id: '',
      cancel_requested: true,
      cancel_acknowledged: null,
      cancel_failed: null,
      cancel_unavailable: true,
      reason: `${this.vendor} adapter not implemented`,
      requested_at: new Date().toISOString(),
      acknowledged_at: null,
    };
  }

  async collectUsage(): Promise<UsageCollectionResult> {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }

  async collectVendorProvenance(): Promise<VendorProvenance> {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }

  async closeSession(): Promise<void> {
    throw new VendorAdapterError('VENDOR_UNSUPPORTED', `${this.vendor} adapter not implemented`);
  }
}

/** OpenAI adapter — NOT_IMPLEMENTED in v0.1. */
export class OpenAIAdapter extends NotImplementedAdapter {
  constructor() {
    super('openai');
  }
}

/** xAI adapter — NOT_IMPLEMENTED in v0.1. */
export class XAIAdapter extends NotImplementedAdapter {
  constructor() {
    super('xai');
  }
}

/** Anthropic adapter — REAL implementation in v0.1. */
export { AnthropicAdapter } from './anthropic-adapter.js';
export { ANTHROPIC_ADAPTER_LIMITATIONS } from './anthropic-adapter.js';

// Re-export normalization
export { canonicalActionNormalizer, CanonicalActionNormalizer } from './normalization.js';
export { canonicalVendorResource, CANONICAL_WORKSPACE_ROOT } from './resource-path.js';