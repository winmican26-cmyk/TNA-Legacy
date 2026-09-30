import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { agentPrincipal, operatorPrincipal, PlatformError } from '../../packages/platform-schema/src/index.js';
import {
  PlatformControlOrchestrator, PlatformExecutionOrchestrator, PlatformFacade, PlatformGateOrchestrator, PlatformStore, type GatePort,
} from '../../packages/platform-core/src/index.js';
import { NOW, envelope } from '../fixture.js';

// The 404 this file pins: `PlatformFacade.submitAndRun` stored an action under the *request body's*
// `tenant_id` while every subsequent read/transition — Gate authorize, execute, retrieve, approve —
// is scoped to the *authenticated credential's* `principal.tenantId`. When those two disagreed the
// action was persisted and then immediately unreachable, so the caller got `404 No platform action
// pa_...` for an id the platform had itself just minted, and approval 404'd for the same reason.
//
// The fix binds the request tenant to the credential and fails closed on a mismatch. Tenant isolation
// is not weakened: the store stays multi-tenant (existing tests create actions in several tenants),
// and cross-tenant reads still 404.

const ADMIN = { kind: 'admin', role: 'administrator' } as const;
const TENANT = 'tenant_demo';
const OTHER_TENANT = 'tenant_other';
const AGENT = 'deployment-agent-17';

// `production.deploy` is in the fixture envelope's `approvals.required_for`, so the real Gate HOLDs it.
// That is deliberate: the facade returns at HELD and the execution orchestrator is never reached, which
// lets these tests exercise the create -> retrieve -> approve chain (the exact 404 path) without
// standing up a broker, and pins the real Gate as the component that produced the HELD state.
const request = (requestId: string, patch: Record<string, unknown> = {}) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'production.deploy', tool: 'deploy.execute', operation: 'write', resource: 'prod.deploy.release',
  // `destination` is runtime-governed and deliberately not a top-level request field. The platform gate
  // orchestrator reads it from `metadata` (platform-core:350), and the fixture envelope's
  // `production.deploy` binding has `destination_required: true`.
  metadata: { destination: 'deploy.internal.company' }, input: { release: '2026.09.09' }, requires_verification: false, ...patch,
});

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-tenant-binding-'));
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const evidence = new Store(':memory:');
  const gate = new Gate(evidence, () => Date.now());
  gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
  // The real Gate clock now uses Date.now() so that PlatformControlOrchestrator.resume() — which
  // computes expiresAt from Date.now() — stays within the envelope's expiry window. The shared
  // fixture envelope's agent.expires_at is 2026-09-09, which is in the past for a real-clock Gate,
  // so this test overrides it with a far-future expiry.
  const testEnvelope = { ...envelope(), agent: { ...envelope().agent, expires_at: '2099-01-01T00:00:00.000Z' } };
  gate.setEnvelope(ADMIN, testEnvelope);
  const gatePort: GatePort = {
    authorize: (principal, request) => gate.authorize(principal, request),
    approve: (principal, { approverRole: _ar, expiresAt, ...req }) => { const r = gate.approve(principal, { request: { ...req, estimatedCostUsd: 0 }, expiresAt }) as { approvalId: string; expiresAt: string }; return { approvalId: r.approvalId, expiresAt: r.expiresAt }; },
    requiredApproverRole: (agentId, action) => gate.requiredApproverRole(agentId, action),
  };
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gatePort);
  // A minimal execution orchestrator stub: approval now drives the action through Gate ALLOW to
  // execution, so the stub must handle the run instead of throwing.
  const executionOrchestrator = { run: async (_principal: unknown, actionId: string) => {
    // Simulate the full execution pipeline: AUTHORIZED → CAPABILITY_ISSUED → MONITORING → EXECUTING → COMPLETED
    const a1 = platform.get(TENANT, actionId);
    const a2 = platform.transition(TENANT, actionId, a1.state_version, 'CAPABILITY_ISSUED');
    const a3 = platform.transition(TENANT, actionId, a2.state_version, 'MONITORING');
    const a4 = platform.transition(TENANT, actionId, a3.state_version, 'EXECUTING');
    const a5 = platform.transition(TENANT, actionId, a4.state_version, 'COMPLETED');
    return { action: a5 };
  } } as unknown as PlatformExecutionOrchestrator;
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const control = new PlatformControlOrchestrator(platform, gatePort, facade);
  return { dir, platform, evidence, gate, gateOrchestrator, facade, control };
}
function close(f: ReturnType<typeof fixture>) { f.platform.close(); f.evidence.close(); rmSync(f.dir, { recursive: true, force: true }); }

test('regression: the action the facade mints is retrievable by the credential that minted it', async () => {
  // The exact defect: submit -> 404. With a matching tenant the returned id must resolve immediately.
  const f = fixture(); try {
    const principal = agentPrincipal('p-agent', TENANT, AGENT);
    const action = await f.facade.submitAndRun(principal, request('tenant_match_1'), 'platform-service');
    assert.equal(action.tenant_id, TENANT);
    const fetched = f.platform.get(principal.tenantId, action.platform_action_id);
    assert.equal(fetched.platform_action_id, action.platform_action_id);
    assert.equal(f.platform.list(principal.tenantId).items.length, 1);
  } finally { close(f); }
});

test('regression: create -> retrieve -> approve no longer 404s', async () => {
  const f = fixture(); try {
    const principal = agentPrincipal('p-agent', TENANT, AGENT);
    const action = await f.facade.submitAndRun(principal, request('tenant_approve_1'), 'platform-service');
    assert.equal(action.state, 'HELD', 'the real Gate must HOLD production.deploy; approval depends on it');

    // Retrieve under the same tenant — this is the read that returned 404 before the fix.
    assert.equal(f.platform.get(TENANT, action.platform_action_id).state, 'HELD');

    // Approve under the same tenant.
    const operator = operatorPrincipal('p-operator', TENANT);
    const resumed = await f.control.resume(operator, action.platform_action_id, { role: 'human-release-manager', subjectId: 'approver-security-desk' });
    assert.ok(['AUTHORIZED', 'AUTHORIZING', 'COMPLETED'].includes(resumed.state), `action progressed past HOLD: state=${resumed.state}`);
    assert.equal(resumed.tenant_id, TENANT);
  } finally { close(f); }
});

test('regression: a request tenant that does not match the credential is refused and persists nothing', async () => {
  // Fail closed *before* persistence. Before the fix this silently created an orphan row under
  // `OTHER_TENANT` that the submitting credential could never read again.
  const f = fixture(); try {
    const principal = agentPrincipal('p-agent', TENANT, AGENT);
    await assert.rejects(
      () => f.facade.submitAndRun(principal, request('tenant_mismatch_1', { tenant_id: OTHER_TENANT }), 'platform-service'),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'FORBIDDEN');
        return true;
      },
    );
    assert.deepEqual(f.platform.list(OTHER_TENANT).items, [], 'no orphan row may be left in the other tenant');
    assert.deepEqual(f.platform.list(TENANT).items, [], 'and none in the submitting tenant either');
  } finally { close(f); }
});

test('regression: the mismatch is refused for a service and a user credential too', async () => {
  // The guard sits in the facade, not the agent role, so every role that may submit is covered.
  const f = fixture(); try {
    for (const principal of [
      agentPrincipal('p-agent', TENANT, AGENT),
      { id: 'p-service', role: 'platform-service' as const, tenantId: TENANT },
      { id: 'p-user', role: 'platform-user' as const, tenantId: TENANT },
    ]) {
      await assert.rejects(
        () => f.facade.submitAndRun(principal, request(`tenant_mismatch_role_${principal.role}`, { tenant_id: OTHER_TENANT }), 'platform-service'),
        (error: unknown) => error instanceof PlatformError && error.code === 'FORBIDDEN',
      );
    }
    assert.deepEqual(f.platform.list(OTHER_TENANT).items, []);
  } finally { close(f); }
});

test('regression: cross-tenant isolation is intact — a foreign action is still NOT_FOUND', async () => {
  // The fix must not turn "refuse the mismatch" into "trust the request body". Reads stay tenant-scoped.
  const f = fixture(); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p-agent', TENANT, AGENT), request('tenant_iso_1'), 'platform-service');
    assert.throws(() => f.platform.get(OTHER_TENANT, action.platform_action_id), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    });
    assert.deepEqual(f.platform.list(OTHER_TENANT).items, []);

    // And an operator from another tenant cannot approve it.
    await assert.rejects(
      () => f.control.resume(operatorPrincipal('p-other-op', OTHER_TENANT), action.platform_action_id, { role: 'human-release-manager', subjectId: 'approver-security-desk' }),
      (error: unknown) => error instanceof PlatformError && error.code === 'NOT_FOUND',
    );
    // The legitimate tenant's action is untouched by the foreign attempt.
    assert.equal(f.platform.get(TENANT, action.platform_action_id).state, 'HELD');
  } finally { close(f); }
});

test('regression: an agent principal still may not approve, and the store remains multi-tenant', async () => {
  const f = fixture(); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p-agent', TENANT, AGENT), request('tenant_roles_1'), 'platform-service');
    // Role guard is unchanged.
    await assert.rejects(
      () => f.control.resume(agentPrincipal('p-agent', TENANT, AGENT), action.platform_action_id, { role: 'human-release-manager', subjectId: 'approver-security-desk' }),
      (error: unknown) => error instanceof PlatformError && error.code === 'FORBIDDEN',
    );
    // `createOrReturn` is untouched: it still serves callers that legitimately create in any tenant.
    const direct = f.platform.createOrReturn(request('tenant_direct_other', { tenant_id: OTHER_TENANT }), 'platform-service');
    assert.equal(direct.tenant_id, OTHER_TENANT);
    assert.equal(f.platform.get(OTHER_TENANT, direct.platform_action_id).platform_action_id, direct.platform_action_id);
    assert.deepEqual(f.platform.list(TENANT).items.map(a => a.platform_action_id), [action.platform_action_id]);
  } finally { close(f); }
});

test('regression: idempotent resubmit under a matching tenant returns the same action', async () => {
  // A retry of the same request must stay idempotent, and must not be mistaken for a tenant mismatch.
  const f = fixture(); try {
    const principal = agentPrincipal('p-agent', TENANT, AGENT);
    const first = await f.facade.submitAndRun(principal, request('tenant_idem_1'), 'platform-service');
    const second = await f.facade.submitAndRun(principal, request('tenant_idem_1'), 'platform-service');
    assert.equal(second.platform_action_id, first.platform_action_id);
    assert.equal(f.platform.list(TENANT).items.length, 1);
  } finally { close(f); }
});
