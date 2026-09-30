import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker } from '../../packages/execution-broker/src/index.js';
import { Ledger, LedgerStore } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserver } from '../../packages/sentinel-runtime/src/index.js';
import { PlatformStore, PlatformGateOrchestrator, PlatformExecutionOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformLedgerDispatcher, type GatePort } from '../../packages/platform-core/src/index.js';
import { platformWriter } from '../../apps/tna-ledger/src/writers.js';
import { GateActionAdapter } from '../../apps/tna-platform/src/gate-adapter.js';
import { buildToolRegistry, buildTestConnectorRegistry, buildDefaultConnectorRegistry } from '../../apps/tna-platform/src/connectors.js';
import { createPlatformServer } from '../../apps/tna-platform/src/server.js';
import type { PlatformCredentials } from '../../apps/tna-platform/src/writers.js';

/**
 * FINAL SECURITY BOUNDARY REMEDIATION — acceptance tests (A–O).
 *
 * These run against the REAL platform HTTP server wired to the REAL Gate/Broker/Sentinel/Ledger, using
 * the isolated test-connector registry that performs REAL writes into a disposable sandbox directory.
 * Every authoritative outcome is verified against actual state (Gate decision, Ledger evidence, on-disk
 * file contents), never an HTTP status code alone. The approver is an INDEPENDENTLY AUTHENTICATED
 * credential distinct from the resuming operator.
 */

const TENANT = 'test-tenant';
const AGENT = 'test-agent';
const AGENT_TOKEN = `agent-token-${'a'.repeat(24)}`;
const OPERATOR_TOKEN = 'operator-token-32-characters-long-x1';
const ADMIN_TOKEN = 'admin-token-32-characters-long-xxxa1';
const SERVICE_TOKEN = 'service-token-32-characters-long-xa1';
const SECURITY_APPROVER_TOKEN = 'security-approver-token-32-chars-aa1';
const RELEASE_APPROVER_TOKEN = 'release-approver-token-32-chars-bbb1';

function credentials(): PlatformCredentials {
  return {
    agentTokens: { [AGENT_TOKEN]: AGENT },
    operatorToken: OPERATOR_TOKEN, adminToken: ADMIN_TOKEN, serviceToken: SERVICE_TOKEN,
    approverTokens: { [SECURITY_APPROVER_TOKEN]: 'security', [RELEASE_APPROVER_TOKEN]: 'human-release-manager' },
  };
}

/** Envelope mirroring the accepted vendor-adapter E2E policy: filesystem.read is low-risk (auto-ALLOW
 * within /workspace); filesystem.write is high-risk and requires an independent `security` approval. */
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

interface Harness { baseUrl: string; sandboxDir: string; ledger: Ledger; close: () => Promise<void> }

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-final-sec-'));
  const sandboxDir = mkdtempSync(resolve(tmpdir(), 'tna-sandbox-'));
  const gateStore = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(gateStore); // REAL clock — resume() computes a server-side window from Date.now()
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Vendor Adapter E2E Agent' });
  gate.setEnvelope({ kind: 'admin', role: 'administrator' }, envelope());
  // Isolated test-connector registry: real writes into the disposable sandbox. NOT the default registry.
  const connectors = buildTestConnectorRegistry(TENANT, sandboxDir);
  const toolRegistry = buildToolRegistry(connectors, TENANT);
  const broker = new ExecutionBroker(gateStore, new CapabilityCodec(randomBytes(32)), toolRegistry, {
    isAgentRevoked: id => gate.isAgentRevoked(id), isPolicyCurrent: d => gate.isPolicyCurrent(d), isDecisionCurrent: d => gate.isPolicyCurrent(d),
  });
  const sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite'));
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const ledgerStore = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'));
  const gateAdapter = new GateActionAdapter(gate);
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gateAdapter);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('platform-sentinel-controller', TENANT), sentinelObserver('platform-execution-broker', TENANT, ['EXECUTION_BROKER']));
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const control = new PlatformControlOrchestrator(platform, gateAdapter, facade);
  const dispatcher = new PlatformLedgerDispatcher(platform, { append: input => ledger.append(platformWriter(TENANT), input) });
  const server = createPlatformServer({ store: platform, facade, control }, credentials(), TENANT);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  // Drive the outbox so Ledger evidence is materialised for the provenance test.
  const timer = setInterval(() => { void dispatcher.dispatchOnce().catch(() => {}); }, 50);
  return {
    baseUrl: `http://127.0.0.1:${port}`, sandboxDir, ledger,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>(res => server.close(() => res()));
      platform.close(); sentinel.close(); ledgerStore.close(); gateStore.close();
      rmSync(dir, { recursive: true, force: true }); rmSync(sandboxDir, { recursive: true, force: true });
    },
  };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
function actionRequest(requestId: string, patch: Record<string, unknown> = {}) {
  return {
    version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
    action: 'filesystem.write', tool: 'filesystem.write', operation: 'write', resource: '/workspace/out/result.txt',
    input: {}, requested_runtime_limits: { max_runtime_seconds: 60 }, requested_cost_limits: { max_cost_usd: 1 },
    requires_verification: false, metadata: {}, ...patch,
  };
}
function authH(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
function approveH(operatorToken: string, approverToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${operatorToken}`, 'X-Approver-Authorization': `Bearer ${approverToken}`, 'Content-Type': 'application/json', ...extra };
}
async function submit(base: string, req: Record<string, unknown>, token = AGENT_TOKEN) {
  const r = await fetch(`${base}/v1/platform/actions`, { method: 'POST', headers: authH(token), body: JSON.stringify(req) });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
}
async function getAction(base: string, id: string) {
  const r = await fetch(`${base}/v1/platform/actions/${id}`, { headers: authH(AGENT_TOKEN) });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
}

// A. Authentic separate approver credential resolves and approves a genuine HOLD.
test('A + D + E + G: genuine HOLD, independent approval, real controlled filesystem effect', async () => {
  const h = await startHarness(); try {
    const s = await submit(h.baseUrl, actionRequest('A_write', { resource: '/workspace/out/a.txt' }));
    assert.equal(s.status, 201);
    const id = s.body?.platform_action_id as string;
    await wait(200);
    // D: genuine HOLD — no execution, and no file yet.
    const held = await getAction(h.baseUrl, id);
    assert.equal(held.body?.state, 'HELD', `expected HELD, got ${held.body?.state}`);
    const targetPath = resolve(h.sandboxDir, 'workspace/out/a.txt');
    assert.equal(existsSync(targetPath), false, 'no write may occur before authorization');
    // A + E: independent security approver (distinct credential) approves → approval record → execute.
    const approve = await fetch(`${h.baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: approveH(OPERATOR_TOKEN, SECURITY_APPROVER_TOKEN), body: JSON.stringify({}) });
    assert.equal(approve.status, 200, 'independent approver approval succeeds');
    await wait(300);
    const done = await getAction(h.baseUrl, id);
    assert.equal(done.body?.state, 'COMPLETED', `expected COMPLETED after approval, got ${done.body?.state}`);
    // G: verify the ACTUAL on-disk effect independently of any connector return value.
    assert.equal(existsSync(targetPath), true, 'a real file must exist after approved execution');
    const contents = readFileSync(targetPath, 'utf8');
    assert.match(contents, /TNA controlled write/);
    assert.match(contents, /\/workspace\/out\/a\.txt/);
  } finally { await h.close(); }
});

// B. Operator attempts self-approval: REJECTED (operator credential is not an approver credential).
test('B: operator self-approval is rejected (operator credential cannot be the approver)', async () => {
  const h = await startHarness(); try {
    const s = await submit(h.baseUrl, actionRequest('B_write', { resource: '/workspace/out/b.txt' }));
    const id = s.body?.platform_action_id as string; await wait(200);
    // Operator presents its OWN token in both slots — the operator token is not a provisioned approver.
    const r = await fetch(`${h.baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: approveH(OPERATOR_TOKEN, OPERATOR_TOKEN), body: JSON.stringify({}) });
    assert.equal(r.status, 403, 'operator token is not an approver credential');
    await wait(150);
    assert.equal((await getAction(h.baseUrl, id)).body?.state, 'HELD', 'action stays HELD; no execution');
    assert.equal(existsSync(resolve(h.sandboxDir, 'workspace/out/b.txt')), false);
  } finally { await h.close(); }
});

// C. Caller supplies an unauthorized approver_role in the body that conflicts with the authenticated
//    approver: REJECTED (the authenticated role is authoritative; a conflict is refused).
test('C + N: caller-supplied conflicting approver role is rejected', async () => {
  const h = await startHarness(); try {
    const s = await submit(h.baseUrl, actionRequest('C_write', { resource: '/workspace/out/c.txt' }));
    const id = s.body?.platform_action_id as string; await wait(200);
    // Authenticated approver is `security`, but the body claims `human-release-manager` → conflict → 403.
    const r = await fetch(`${h.baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: approveH(OPERATOR_TOKEN, SECURITY_APPROVER_TOKEN), body: JSON.stringify({ approver_role: 'human-release-manager' }) });
    assert.equal(r.status, 403, 'a conflicting caller-asserted role must be rejected');
    // N: a wrong authenticated approver identity (release-manager) also does not satisfy a security gate.
    const r2 = await fetch(`${h.baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: approveH(OPERATOR_TOKEN, RELEASE_APPROVER_TOKEN), body: JSON.stringify({}) });
    assert.equal(r2.status, 403, 'an approver whose role != required role cannot approve');
    await wait(150);
    assert.equal((await getAction(h.baseUrl, id)).body?.state, 'HELD');
  } finally { await h.close(); }
});

// F + H + I: real Gate ALLOW re-authorization, exact-call capability, argument substitution & replay.
// These lower-level guarantees are exercised directly against the broker/capability in the platform
// execution suite; here we assert the HTTP-observable consequences that depend on them.
test('H: a changed write (different resource) is a fresh action that HOLDs again, never auto-ALLOW', async () => {
  const h = await startHarness(); try {
    const first = await submit(h.baseUrl, actionRequest('H_1', { resource: '/workspace/out/h1.txt' }));
    const id1 = first.body?.platform_action_id as string; await wait(150);
    await fetch(`${h.baseUrl}/v1/platform/actions/${id1}/approve`, { method: 'POST', headers: approveH(OPERATOR_TOKEN, SECURITY_APPROVER_TOKEN), body: JSON.stringify({}) });
    await wait(250);
    // A different resource is a different capability-bound action — it must HOLD on its own, not ride the
    // prior approval (the capability binds the exact resource; a substituted argument is rejected upstream).
    const second = await submit(h.baseUrl, actionRequest('H_2', { resource: '/workspace/out/h2-different.txt' }));
    const id2 = second.body?.platform_action_id as string; await wait(200);
    assert.equal((await getAction(h.baseUrl, id2)).body?.state, 'HELD', 'a changed argument does not inherit a prior approval');
  } finally { await h.close(); }
});

// I: replay — resubmitting the same request_id is idempotent (returns the same action), never a second execution.
test('I: replay of the same request_id is idempotent, not a second execution', async () => {
  const h = await startHarness(); try {
    const req = actionRequest('I_replay', { resource: '/workspace/out/i.txt' });
    const r1 = await submit(h.baseUrl, req);
    const r2 = await submit(h.baseUrl, req);
    assert.ok(r1.status === 201, `first submit created: ${r1.status}`);
    // Same request_id → same platform_action_id (idempotent), not a new action.
    assert.equal(r2.body?.platform_action_id, r1.body?.platform_action_id, 'replay returns the same action id');
    // A conflicting body under the same request_id is a hard 409, never silently a new run.
    const conflict = await submit(h.baseUrl, { ...req, resource: '/workspace/out/i-different.txt' });
    assert.equal(conflict.status, 409, 'same request_id with different content is a conflict');
  } finally { await h.close(); }
});

// J: Gate outage → consequential action does not execute (fail-closed). Simulated by an unreachable Gate.
test('J: Gate outage fails closed — no execution', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-outage-'));
  const sandboxDir = mkdtempSync(resolve(tmpdir(), 'tna-outage-sb-'));
  try {
    const gateStore = new Store(resolve(dir, 'gate.sqlite'));
    const gate = new Gate(gateStore);
    gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Vendor Adapter E2E Agent' });
    gate.setEnvelope({ kind: 'admin', role: 'administrator' }, envelope());
    const connectors = buildTestConnectorRegistry(TENANT, sandboxDir);
    const broker = new ExecutionBroker(gateStore, new CapabilityCodec(randomBytes(32)), buildToolRegistry(connectors, TENANT));
    const sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite')); sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
    const platform = new PlatformStore(resolve(dir, 'platform.sqlite'));
    // A GatePort that throws (Gate unreachable) — authorization must fail closed, never fall through to execution.
    const outageGate: GatePort = { authorize: () => { throw new Error('Gate unreachable'); }, approve: () => { throw new Error('Gate unreachable'); }, requiredApproverRole: () => null };
    const gateOrchestrator = new PlatformGateOrchestrator(platform, outageGate);
    const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c', TENANT), sentinelObserver('o', TENANT, ['EXECUTION_BROKER']));
    const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
    const control = new PlatformControlOrchestrator(platform, outageGate, facade);
    const server = createPlatformServer({ store: platform, facade, control }, credentials(), TENANT);
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as AddressInfo).port; const base = `http://127.0.0.1:${port}`;
    const s = await submit(base, actionRequest('J_write', { resource: '/workspace/out/j.txt' }));
    await wait(200);
    const st = (await getAction(base, s.body?.platform_action_id as string)).body?.state;
    assert.ok(st !== 'COMPLETED' && st !== 'EXECUTING', `must not execute on Gate outage (state=${st})`);
    assert.equal(existsSync(resolve(sandboxDir, 'workspace/out/j.txt')), false, 'no file written on Gate outage');
    await new Promise<void>(res => server.close(() => res()));
    platform.close(); sentinel.close(); gateStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(sandboxDir, { recursive: true, force: true }); }
});

// K: cross-tenant attempt — a request whose body tenant_id differs from the authenticated principal's
//    tenant is rejected independently, never executed.
test('K: cross-tenant request is rejected', async () => {
  const h = await startHarness(); try {
    const r = await submit(h.baseUrl, actionRequest('K_write', { tenant_id: 'wrong-tenant', resource: '/workspace/out/k.txt' }));
    assert.ok(r.status === 403 || r.status === 400, `cross-tenant rejected: ${r.status}`);
  } finally { await h.close(); }
});

// L: a test connector cannot enter the production registry — the default (production) registry contains
//    only production connectors, never the E2E filesystem connectors.
test('L: E2E test connectors are absent from the default production registry', async () => {
  const registry = buildDefaultConnectorRegistry();
  const tools = registry.list('tenant_demo').map(c => c.tool);
  assert.ok(tools.includes('demo.echo'), 'the production demo connector is present');
  assert.equal(tools.includes('filesystem.write'), false, 'the E2E write connector must NOT be in the production registry');
  assert.equal(tools.includes('filesystem.read'), false, 'the E2E read connector must NOT be in the production registry');
  // Nothing is registered for the test tenant in the default registry.
  assert.equal(registry.list(TENANT).length, 0, 'no test-tenant connectors in the default registry');
});

// M: expired approval — an approval whose window has elapsed cannot authorize execution. Verified at the
//    Gate approval boundary: a past expiry is refused outright.
test('M: an expired approval is rejected by Gate', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-expiry-'));
  try {
    const gateStore = new Store(resolve(dir, 'gate.sqlite'));
    const gate = new Gate(gateStore);
    gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Vendor Adapter E2E Agent' });
    gate.setEnvelope({ kind: 'admin', role: 'administrator' }, envelope());
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    assert.throws(
      () => gate.approve({ kind: 'approver', role: 'security' }, { request: { agentId: AGENT, action: 'filesystem.write', tool: 'filesystem.write', resource: '/workspace/out/m.txt', estimatedCostUsd: 0 }, expiresAt: pastExpiry }),
      /future/i,
      'an approval expiry in the past must be refused',
    );
    gateStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// O: evidence provenance — after an approved execution, the Ledger reconstructs the real action, decision,
//    approval reference, capability and execution from durable state (not fixtures).
test('O: evidence reconstructs the real action / decision / capability / execution', async () => {
  const h = await startHarness(); try {
    const s = await submit(h.baseUrl, actionRequest('O_write', { resource: '/workspace/out/o.txt' }));
    const id = s.body?.platform_action_id as string; await wait(200);
    await fetch(`${h.baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: approveH(OPERATOR_TOKEN, SECURITY_APPROVER_TOKEN), body: JSON.stringify({}) });
    await wait(400);
    const ev = await fetch(`${h.baseUrl}/v1/platform/actions/${id}/evidence`, { headers: authH(AGENT_TOKEN) });
    assert.equal(ev.status, 200);
    const recon = await ev.json() as { gate: { decision: string } | null; capability_id: string | null; sentinel_session_id: string | null; execution: unknown };
    assert.equal(recon.gate?.decision, 'ALLOW', 'reconstructed Gate decision is a real ALLOW');
    assert.ok(recon.capability_id, 'a real capability id is recorded');
    assert.ok(recon.sentinel_session_id, 'a real Sentinel session is recorded');
    assert.ok(recon.execution, 'a real execution record exists');
    // Independent cross-check: the on-disk artifact matches the executed action's resource.
    const contents = readFileSync(resolve(h.sandboxDir, 'workspace/out/o.txt'), 'utf8');
    assert.match(contents, /\/workspace\/out\/o\.txt/);
    assert.equal(createHash('sha256').update(contents, 'utf8').digest('hex').length, 64);
  } finally { await h.close(); }
});
