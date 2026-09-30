import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, BrokerError } from '../../packages/execution-broker/src/index.js';
import { buildToolRegistry, buildTestConnectorRegistry } from '../../apps/tna-platform/src/connectors.js';

/**
 * FINAL TEST-VALIDITY REMEDIATION — capability-level binding & single-use (judge defects 1 and 2).
 *
 * These replace the INVALID HTTP-level checks in `final-security-remediation.test.ts` (tests H and I).
 * They exercise the REAL accepted `ExecutionBroker` directly at capability level:
 *
 *   H — same-capability ARGUMENT SUBSTITUTION: one capability C is issued for approved action A; a
 *       redemption that mutates exactly one BOUND field (resource) is attempted with the SAME C, and the
 *       real Broker rejects it with a binding mismatch. A legitimate second capability proves the bound
 *       action itself redeems (positive control) — no token is cloned or fabricated.
 *   I — same-capability REPLAY: one capability C is redeemed successfully once, then the SAME C is
 *       redeemed a second time and the real Broker rejects it as consumed/single-use.
 *
 * No Platform HTTP flow, no request_id idempotency, no HTTP 409. No production code is modified — the
 * accepted Broker already enforces both properties; only the tests are corrected.
 */

const TENANT = 'test-tenant';
const AGENT = 'test-agent';
const AGENT_PRINCIPAL = { kind: 'agent', agentId: AGENT } as const;
const ADMIN = { kind: 'admin', role: 'administrator' } as const;
const SECURITY_APPROVER = { kind: 'approver', role: 'security' } as const;

/** Accepted E2E envelope: filesystem.write is high-risk and requires an independent `security` approval;
 * filesystem.read is low-risk. Matches `final-security-remediation.test.ts`. */
function envelope() {
  return {
    version: '1.0',
    agent: { id: AGENT, name: 'Vendor Adapter E2E Agent', role: 'developer', owner: 'platform-team', environment: 'test', expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() },
    objective: { task_id: 'vendor-adapter-e2e', goal: 'Read and write files inside the declared workspace scope', allowed_outcomes: ['read workspace file', 'write workspace file'], forbidden_outcomes: ['read outside the declared workspace scope', 'write outside the declared workspace scope'] },
    resources: { repositories: { read: [], write: [] }, files: { read: ['/workspace/**'], write: ['/workspace/**'] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: ['filesystem.read', 'filesystem.write'], deny: ['shell.unrestricted', 'secret.create', 'iam.modify'] },
    network: { allow: [], deny: ['*'] },
    secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
    limits: { max_runtime_seconds: 3600, max_tool_calls: 100, max_external_requests: 0, max_cost_usd: 10, max_retries_per_action: 2 },
    approvals: { required_for: [{ action: 'filesystem.write', approver_role: 'security' }] },
    risk: { level: 'medium', blast_radius: 'workspace', rollback_required: true },
    evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'resources_read', 'resources_modified', 'timestamps'], retention_days: 90 },
    violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
    action_bindings: [
      { action: 'filesystem.read', outcome: 'read workspace file', tool: 'filesystem.read', resource_kind: 'files', operation: 'read', destination_required: false },
      { action: 'filesystem.write', outcome: 'write workspace file', tool: 'filesystem.write', resource_kind: 'files', operation: 'write', destination_required: false },
    ],
  };
}

/** Reach a real ALLOW decision for `filesystem.write <resource>` via an independent security approval. */
function allowDecisionId(fixtureStore: Gate, resource: string): string {
  const request = { agentId: AGENT, action: 'filesystem.write', tool: 'filesystem.write', resource, estimatedCostUsd: 0 };
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const approval = fixtureStore.approve(SECURITY_APPROVER, { request, expiresAt }) as { approvalId: string };
  const decision = fixtureStore.authorize(AGENT_PRINCIPAL, { ...request, approvalId: approval.approvalId }) as { decisionId: string; decision: string };
  if (decision.decision !== 'ALLOW') throw new Error(`expected ALLOW, got ${decision.decision}`);
  return decision.decisionId;
}

/** A well-formed RedeemInput for action A. For a non-demo tool the Broker binds on tool/resource/
 * operation/destination (not input_hash), so mutating `resource` is a mutation of a genuinely BOUND
 * field. `input_hash` is a valid 64-hex placeholder accepted by the Broker's input validation. */
function redeemInput(token: string, resource: string, overrides: Record<string, unknown> = {}) {
  return { token, tool: 'filesystem.write', resource, operation: 'read', input: {}, input_hash: 'a'.repeat(64), ...overrides };
}

/** Broker + its backing Gate, sharing one evidence store, plus cleanup. */
interface FullFixture { broker: ExecutionBroker; gate: Gate; close: () => void }
function startFullFixture(): FullFixture {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-cap-'));
  const sandboxDir = mkdtempSync(resolve(tmpdir(), 'tna-cap-sb-'));
  const store = new Store(resolve(dir, 'evidence.sqlite'));
  const gate = new Gate(store);
  gate.register(ADMIN, { id: AGENT, name: 'Vendor Adapter E2E Agent' });
  gate.setEnvelope(ADMIN, envelope());
  const broker = new ExecutionBroker(store, new CapabilityCodec(randomBytes(32)), buildToolRegistry(buildTestConnectorRegistry(TENANT, sandboxDir), TENANT), {
    isAgentRevoked: id => gate.isAgentRevoked(id), isPolicyCurrent: d => gate.isPolicyCurrent(d), isDecisionCurrent: d => gate.isPolicyCurrent(d),
  });
  return { broker, gate, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(sandboxDir, { recursive: true, force: true }); } };
}

// ── H — SAME-CAPABILITY ARGUMENT SUBSTITUTION ─────────────────────────────────────────────────────
test('H (capability-level): the SAME capability C is rejected when a bound field (resource) is mutated', async () => {
  const f = startFullFixture(); try {
    const boundResource = '/workspace/out/A.txt';
    // A: approved filesystem.write → real ALLOW → issue the real capability C bound to A.
    const decisionId = allowDecisionId(f.gate, boundResource);
    const issued = f.broker.issue(AGENT_PRINCIPAL, decisionId);
    assert.ok(issued.token, 'capability C issued for A');
    assert.equal(issued.payload.resource, boundResource, 'C is bound to A.resource');

    // Mutate exactly ONE bound field (resource) → action B → redeem SAME C for B → binding mismatch.
    const mutatedResource = '/workspace/out/B-different.txt';
    await assert.rejects(
      () => f.broker.redeem(AGENT_PRINCIPAL, redeemInput(issued.token, mutatedResource)),
      (e: unknown) => e instanceof BrokerError && e.status === 403 && e.message === 'Capability binding mismatch',
      'the real Broker rejects the SAME capability when a bound field is substituted',
    );

    // Positive control: a legitimate, separately issued capability for the UNMUTATED A redeems. We use a
    // second real ALLOW+issue (never a cloned/fabricated token) because C above was spent on the negative
    // check attempt only if it had bound — it did not, so C is still unconsumed, but we prove the happy
    // path independently to show the mutation, not the tool, is what was rejected.
    const decisionId2 = allowDecisionId(f.gate, '/workspace/out/A2.txt');
    const issued2 = f.broker.issue(AGENT_PRINCIPAL, decisionId2);
    const ok = await f.broker.redeem(AGENT_PRINCIPAL, redeemInput(issued2.token, '/workspace/out/A2.txt'));
    assert.equal(ok.state, 'SUCCEEDED', 'the unmutated bound action redeems successfully (positive control)');
  } finally { f.close(); }
});

// ── I — SAME-CAPABILITY REPLAY ────────────────────────────────────────────────────────────────────
test('I (capability-level): the SAME capability C cannot be redeemed twice (single-use)', async () => {
  const f = startFullFixture(); try {
    const boundResource = '/workspace/out/replay.txt';
    const decisionId = allowDecisionId(f.gate, boundResource);
    const issued = f.broker.issue(AGENT_PRINCIPAL, decisionId);
    const capabilityId = issued.payload.capability_id; // non-secret identifier for diagnostics

    // First redemption of C succeeds.
    const first = await f.broker.redeem(AGENT_PRINCIPAL, redeemInput(issued.token, boundResource));
    assert.equal(first.state, 'SUCCEEDED', `first redemption of ${capabilityId} succeeds`);

    // Second redemption of the SAME capability token is rejected as consumed/single-use.
    await assert.rejects(
      () => f.broker.redeem(AGENT_PRINCIPAL, redeemInput(issued.token, boundResource)),
      (e: unknown) => e instanceof BrokerError && e.status === 409 && /consumed/i.test(e.message),
      'the real Broker rejects a second redemption of the same capability',
    );
  } finally { f.close(); }
});
