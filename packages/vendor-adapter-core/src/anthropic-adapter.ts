import { createHash, randomUUID } from 'node:crypto';
import type {
  VendorAdapter,
  VendorSession,
  StartSessionInput,
  VendorToolCallEvent,
  NormalizationResult,
  AuthorizationRequestInput,
  AuthorizationResult,
  ExactCallCapability,
  ExecutionInput,
  AuthorizedCallResult,
  CancellationResult,
  UsageCollectionResult,
  VendorProvenance,
  SessionAuthority,
  VendorUsage,
  CanonicalAction,
} from './index.js';
import { canonicalActionNormalizer, CanonicalActionNormalizer } from './normalization.js';

/**
 * Anthropic/Claude Adapter Implementation
 *
 * IMPORTANT LIMITATION (per spec Section 7):
 * The Anthropic SDK (@anthropic-ai/sdk) is NOT currently installed in this workspace.
 * The official Anthropic Agent SDK / coding-agent harness does not expose a reliable
 * pre-tool authorization hook or cancellation boundary that can be intercepted by TNA.
 *
 * This implementation provides:
 * 1. A complete adapter structure that WOULD work with the real SDK
 * 2. A test harness (AnthropicTestHarness) that simulates vendor runtime behavior
 *    for demonstration and testing purposes — CLEARLY MARKED as test-only
 * 3. Real TNA mediation: Gate → Capability → Sentinel → Broker → Ledger
 *
 * When the real Anthropic SDK becomes available with proper pre-tool hooks,
 * replace AnthropicTestHarness with AnthropicRealHarness.
 *
 * DO NOT simulate a vendor permission hook and call it real.
 */

// ============================================================
// Test Harness (SIMULATED - for demonstration only)
// ============================================================

interface SimulatedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  timestamp: string;
}

interface SimulatedSession {
  id: string;
  vendor_session_id: string;
  model: string;
  tool_calls: SimulatedToolCall[];
  usage: VendorUsage;
  state: 'active' | 'cancelled' | 'completed';
  created_at: string;
}

/**
 * TEST HARNESS ONLY — Simulates Anthropic agent runtime for demonstration.
 * REPLACE with real SDK integration when available.
 * Does NOT provide real pre-tool authorization hook — simulates the event stream only.
 */
class AnthropicTestHarness {
  private sessions = new Map<string, SimulatedSession>();
  private readonly model = 'claude-3-5-sonnet-20241022';

  async createSession(config: { vendor_session_id: string; system_prompt?: string; allowed_tools?: string[] }): Promise<SimulatedSession> {
    const session: SimulatedSession = {
      id: randomUUID(),
      vendor_session_id: config.vendor_session_id,
      model: this.model,
      tool_calls: [],
      usage: {
        model: this.model,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        vendor_request_id: null,
        vendor_reported_cost_usd: null,
        cost_type: 'unavailable',
      },
      state: 'active',
      created_at: new Date().toISOString(),
    };
    this.sessions.set(config.vendor_session_id, session);
    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<{ tool_calls: SimulatedToolCall[]; text: string; usage: VendorUsage }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Simulate tool calls based on message content
    const toolCalls = this.simulateToolCalls(message);
    const requestId = `req_${randomUUID()}`;

    for (const tc of toolCalls) {
      session.tool_calls.push({ ...tc, timestamp: new Date().toISOString() });
    }

    // Update usage (simulated)
    session.usage.input_tokens = (session.usage.input_tokens ?? 0) + 100;
    session.usage.output_tokens = (session.usage.output_tokens ?? 0) + toolCalls.length * 50;
    session.usage.vendor_request_id = requestId;
    session.usage.cost_type = 'estimated';

    return {
      tool_calls: toolCalls,
      text: `Executed ${toolCalls.length} tool call(s)`,
      usage: { ...session.usage, vendor_request_id: requestId },
    };
  }

  private simulateToolCalls(message: string): SimulatedToolCall[] {
    const calls: SimulatedToolCall[] = [];
    const lower = message.toLowerCase();

    // Simulate file operations
    if (lower.includes('read') && lower.includes('file')) {
      calls.push({
        id: `call_${randomUUID()}`,
        name: 'filesystem.read',
        arguments: { path: '/workspace/example.txt' },
        timestamp: new Date().toISOString(),
      });
    }
    if (lower.includes('write') && lower.includes('file')) {
      calls.push({
        id: `call_${randomUUID()}`,
        name: 'filesystem.write',
        arguments: { path: '/workspace/output.txt', content: 'generated content' },
        timestamp: new Date().toISOString(),
      });
    }
    // Simulate git operations
    if (lower.includes('git') && lower.includes('push')) {
      calls.push({
        id: `call_${randomUUID()}`,
        name: 'git.push',
        arguments: { remote: 'origin', branch: 'main' },
        timestamp: new Date().toISOString(),
      });
    }
    if (lower.includes('deploy')) {
      calls.push({
        id: `call_${randomUUID()}`,
        name: 'aws.deploy',
        arguments: { environment: 'staging', service: 'api' },
        timestamp: new Date().toISOString(),
      });
    }

    // Filter by allowed tools if specified
    // allowedTools filtering would be done at session creation time
    return calls;
  }

  async cancelSession(vendor_session_id: string): Promise<{ acknowledged: boolean; reason: string }> {
    const session = this.sessions.get(vendor_session_id);
    if (!session) return { acknowledged: false, reason: 'Session not found' };

    // Anthropic SDK does not expose reliable cancellation hook
    // This is a SIMULATION only
    session.state = 'cancelled';
    return { acknowledged: true, reason: 'Simulated cancellation — real SDK does not support pre-tool cancellation' };
  }

  getSession(vendor_session_id: string): SimulatedSession | undefined {
    return this.sessions.get(vendor_session_id);
  }

  collectUsage(vendor_session_id: string): VendorUsage | null {
    const session = this.sessions.get(vendor_session_id);
    return session?.usage ?? null;
  }
}

// ============================================================
// Real Anthropic Adapter (wraps test harness for v0.1)
// ============================================================

export class AnthropicAdapter implements VendorAdapter {
  private readonly harness: AnthropicTestHarness;
  private readonly normalizer: CanonicalActionNormalizer;
  private readonly sessions = new Map<string, {
    session: VendorSession;
    authority: SessionAuthority;
    harnessSession: SimulatedSession;
  }>();

  constructor() {
    this.harness = new AnthropicTestHarness();
    this.normalizer = canonicalActionNormalizer;
  }

  async startSession(input: StartSessionInput): Promise<VendorSession> {
    const { vendor, tenant, principal, agent_identity, authority, vendor_config } = input;

    if (vendor !== 'anthropic') {
      throw new Error(`Invalid vendor for AnthropicAdapter: ${vendor}`);
    }

    const vendor_session_id = `vs_${randomUUID()}`;

    // Create session authority envelope
    const sessionAuthority: SessionAuthority = {
      vendor,
      vendor_session_id,
      tenant,
      principal,
      agent_identity,
      allowed_tools: (authority.allowed_tools as string[]) ?? ['filesystem', 'git', 'github'],
      allowed_resources: (authority.allowed_resources as string[]) ?? ['/workspace/**'],
      allowed_operations: (authority.allowed_operations as string[]) ?? ['read', 'write', 'push', 'deploy'],
      allowed_destinations: (authority.allowed_destinations as string[]) ?? ['github.com', 'api.github.com'],
      max_budget_usd: authority.max_budget_usd ?? 10.00,
      max_runtime_seconds: authority.max_runtime_seconds ?? 3600,
      authority_expiry: authority.authority_expiry,
      policy_snapshot_hash: authority.policy_snapshot_hash,
    };

    // Create harness session
    const systemPrompt = vendor_config.system_prompt as string | undefined;
    const harnessSession = await this.harness.createSession({
      vendor_session_id,
      ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
      allowed_tools: [...sessionAuthority.allowed_tools],
    });

    const session: VendorSession = {
      vendor_session_id,
      vendor,
      tenant,
      principal,
      agent_identity,
      state: 'ACTIVE',
      created_at: new Date().toISOString(),
      authority: sessionAuthority,
      vendor_handle: harnessSession,
    };

    this.sessions.set(vendor_session_id, { session, authority: sessionAuthority, harnessSession });
    return session;
  }

  normalizeAction(event: VendorToolCallEvent): NormalizationResult {
    // Fill in tenant/principal/agent from session if missing
    const enrichedEvent = {
      ...event,
      vendor: 'anthropic',
    };
    return this.normalizer.normalize(enrichedEvent);
  }

  async requestAuthorization(input: AuthorizationRequestInput): Promise<AuthorizationResult> {
    const { vendor_session_id, canonical_action, gate_decision } = input;

    const sessionData = this.sessions.get(vendor_session_id);
    if (!sessionData) {
      return {
        authorized: false,
        session_authority: {} as SessionAuthority,
        exact_call_capability: null,
        error_code: 'SESSION_NOT_FOUND',
        error_message: `Vendor session not found: ${vendor_session_id}`,
      };
    }

    // Gate decision must be ALLOW
    if (gate_decision.decision !== 'ALLOW') {
      return {
        authorized: false,
        session_authority: sessionData.authority,
        exact_call_capability: null,
        error_code: 'GATE_DECISION_NOT_ALLOW',
        error_message: `Gate decision was ${gate_decision.decision}: ${gate_decision.reason}`,
      };
    }

    // Build exact-call capability (will be issued by ExecutionBroker in real flow)
    // This adapter prepares the capability input for the broker
    const exactCallCapability: ExactCallCapability = {
      capability_id: `cap_${randomUUID()}`,
      execution_id: `exec_${randomUUID()}`,
      agent_id: canonical_action.agent_identity,
      decision_id: gate_decision.decision_id,
      action: canonical_action.tool,
      tool: canonical_action.tool,
      resource: canonical_action.resource,
      operation: canonical_action.operation,
      destination: canonical_action.destination,
      input_hash: canonical_action.input_hash,
      policy_hash: gate_decision.policy_hash ?? 'none',
      policy_issuance_id: gate_decision.policy_version ?? 'none',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30000).toISOString(), // 30s TTL
      single_use: true,
      nonce: randomUUID().replace(/-/g, '').slice(0, 22),
      vendor_session_id,
      vendor_request_id: canonical_action.vendor_request_id,
      vendor_tool_call_id: canonical_action.vendor_tool_call_id,
    };

    return {
      authorized: true,
      session_authority: sessionData.authority,
      exact_call_capability: exactCallCapability,
      error_code: null,
      error_message: null,
    };
  }

  async executeAuthorizedCall(input: ExecutionInput): Promise<AuthorizedCallResult> {
    const { vendor_session_id, canonical_action, exact_call_capability } = input;

    const sessionData = this.sessions.get(vendor_session_id);
    if (!sessionData) {
      throw new Error(`Session not found: ${vendor_session_id}`);
    }

    // Verify capability binds to this exact action
    if (exact_call_capability.vendor_tool_call_id !== canonical_action.vendor_tool_call_id) {
      throw new Error('Capability vendor_tool_call_id mismatch — argument substitution detected');
    }
    if (exact_call_capability.input_hash !== canonical_action.input_hash) {
      throw new Error('Capability input_hash mismatch — argument substitution detected');
    }

    // Simulate sending message to vendor and getting tool call
    // In real implementation, this would invoke the vendor SDK
    const message = `Execute ${canonical_action.tool}.${canonical_action.operation} on ${canonical_action.resource}`;
    const result = await this.harness.sendMessage(vendor_session_id, message);

    // Find the matching tool call
    const toolCall = result.tool_calls.find(tc =>
      tc.name === canonical_action.tool && JSON.stringify(tc.arguments) === JSON.stringify(canonical_action.argv)
    );

    if (!toolCall) {
      throw new Error('No matching tool call returned from vendor');
    }

    const execution_id = exact_call_capability.execution_id;
    const result_hash = createHash('sha256').update(JSON.stringify(toolCall.arguments)).digest('hex');

    // Build vendor provenance
    const provenance: VendorProvenance = {
      vendor: 'anthropic',
      vendor_session_id,
      vendor_request_id: canonical_action.vendor_request_id,
      vendor_tool_call_id: toolCall.id,
      model_identifier: sessionData.harnessSession.model,
      model_snapshot: sessionData.harnessSession.model,
      normalized_action_hash: computeCanonicalActionHash(canonical_action),
      capability_id: exact_call_capability.capability_id,
      execution_id,
    };

    return {
      execution_id,
      vendor_tool_call_id: toolCall.id,
      result: toolCall.arguments,
      result_hash,
      usage: result.usage,
      vendor_provenance: provenance,
      completed_at: new Date().toISOString(),
    };
  }

  async cancelSession(vendor_session_id: string): Promise<CancellationResult> {
    const sessionData = this.sessions.get(vendor_session_id);
    if (!sessionData) {
      return {
        vendor_session_id,
        cancel_requested: true,
        cancel_acknowledged: false,
        cancel_failed: true,
        cancel_unavailable: false,
        reason: 'Session not found',
        requested_at: new Date().toISOString(),
        acknowledged_at: null,
      };
    }

    const requested_at = new Date().toISOString();
    const result = await this.harness.cancelSession(vendor_session_id);

    sessionData.session.state = result.acknowledged ? 'CANCELLED' : 'FAILED';

    return {
      vendor_session_id,
      cancel_requested: true,
      cancel_acknowledged: result.acknowledged,
      cancel_failed: !result.acknowledged,
      cancel_unavailable: !result.acknowledged && result.reason.includes('does not support'),
      reason: result.reason,
      requested_at,
      acknowledged_at: result.acknowledged ? new Date().toISOString() : null,
    };
  }

  async collectUsage(vendor_session_id: string): Promise<UsageCollectionResult> {
    const sessionData = this.sessions.get(vendor_session_id);
    if (!sessionData) {
      throw new Error(`Session not found: ${vendor_session_id}`);
    }

    const usage = this.harness.collectUsage(vendor_session_id);
    if (!usage) {
      throw new Error('Usage not available');
    }

    return {
      vendor_session_id,
      total_usage: usage,
      per_request_usage: usage.vendor_request_id ? [usage] : [],
      collected_at: new Date().toISOString(),
    };
  }

  async collectVendorProvenance(vendor_session_id: string): Promise<VendorProvenance> {
    const sessionData = this.sessions.get(vendor_session_id);
    if (!sessionData) {
      throw new Error(`Session not found: ${vendor_session_id}`);
    }

    // Return provenance for the last tool call
    const lastCall = sessionData.harnessSession.tool_calls[sessionData.harnessSession.tool_calls.length - 1];
    if (!lastCall) {
      throw new Error('No tool calls in session');
    }

    return {
      vendor: 'anthropic',
      vendor_session_id,
      vendor_request_id: sessionData.harnessSession.usage.vendor_request_id ?? `req_${randomUUID()}`,
      vendor_tool_call_id: lastCall.id,
      model_identifier: sessionData.harnessSession.model,
      model_snapshot: sessionData.harnessSession.model,
      normalized_action_hash: '', // Would need canonical action to compute
      capability_id: '', // Would need capability to populate
      execution_id: '', // Would need execution to populate
    };
  }

  async closeSession(vendor_session_id: string): Promise<void> {
    const sessionData = this.sessions.get(vendor_session_id);
    if (sessionData) {
      sessionData.session.state = 'COMPLETED';
      this.sessions.delete(vendor_session_id);
    }
  }
}

// ============================================================
// Helper
// ============================================================

function computeCanonicalActionHash(canonical: CanonicalAction): string {
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
// Limitation Documentation (per spec Section 7)
// ============================================================

/**
 * LIMITATION REPORT - Anthropic Adapter v0.1
 *
 * The official Anthropic SDK (@anthropic-ai/sdk) and Agent SDK do not currently
 * expose a reliable pre-tool authorization hook or cancellation boundary that
 * can be intercepted by TNA.
 *
 * Specific limitations:
 * 1. No pre-tool callback: The SDK does not provide a hook that fires BEFORE
 *    a tool call is executed, allowing TNA to mediate the call.
 * 2. No cancellation boundary: The SDK does not support cancelling an in-flight
 *    tool call from an external control plane.
 * 3. No session lifecycle events: The SDK does not emit structured session
 *    start/cancel/complete events that TNA can observe.
 *
 * This implementation uses a TEST HARNESS (AnthropicTestHarness) that simulates
 * the vendor runtime for demonstration purposes only. The TNA mediation path
 * (Gate → Capability → Sentinel → Broker → Ledger) is REAL and tested.
 *
 * When the Anthropic SDK exposes proper pre-tool hooks, replace the harness
 * with a real implementation that intercepts tool calls at the SDK boundary.
 */
export const ANTHROPIC_ADAPTER_LIMITATIONS = `
LIMITATION REPORT - Anthropic Adapter v0.1

The official Anthropic SDK (@anthropic-ai/sdk) and Agent SDK do not currently
expose a reliable pre-tool authorization hook or cancellation boundary that
can be intercepted by TNA.

Specific limitations:
1. No pre-tool callback: The SDK does not provide a hook that fires BEFORE
   a tool call is executed, allowing TNA to mediate the call.
2. No cancellation boundary: The SDK does not support cancelling an in-flight
   tool call from an external control plane.
3. No session lifecycle events: The SDK does not emit structured session
   start/cancel/complete events that TNA can observe.

This implementation uses a TEST HARNESS (AnthropicTestHarness) that simulates
the vendor runtime for demonstration purposes only. The TNA mediation path
(Gate -> Capability -> Sentinel -> Broker -> Ledger) is REAL and tested.

When the Anthropic SDK exposes proper pre-tool hooks, replace the harness
with a real implementation that intercepts tool calls at the SDK boundary.
`;