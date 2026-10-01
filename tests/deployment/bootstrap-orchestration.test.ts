import assert from 'node:assert/strict';
import test from 'node:test';
import { runPreflight } from '../../packages/deployment-bootstrap/src/preflight.js';
import { aggregateReadiness, type ReadinessInputs, type GovernedActionEvidence } from '../../packages/deployment-bootstrap/src/readiness.js';
import { buildEvidencePackage, verifyEvidencePackage, findSecretShaped } from '../../packages/deployment-bootstrap/src/evidence.js';
import type { PreflightReport } from '../../packages/deployment-bootstrap/src/preflight.js';
import { assessGoLive } from '../../apps/tna-operator/src/go-live.js';

const REPO = process.cwd();

// Injected stubs keep these tests hermetic and READ-ONLY — no real docker/git/ports touched.
function okCommand(map: Record<string, string>) {
  return (cmd: string, args: readonly string[]): string => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [prefix, out] of Object.entries(map)) if (key.startsWith(prefix)) return out;
    throw new Error(`no stub for: ${key}`);
  };
}

test('preflight is read-only and reports the four verdicts; a healthy host PASSes/ WARNs, never silently', async () => {
  const report = await runPreflight({
    repoRoot: REPO,
    expectedRevision: 'e5cc33f8068c6c2542ff298ea821899df56ab65e',
    minFreeMemGb: 0, // force the memory check to PASS deterministically regardless of CI host
    runCommand: okCommand({
      'docker version': '29.8.0',
      'docker compose version': 'v2.39.1',
      'git -C': 'e5cc33f8068c6c2542ff298ea821899df56ab65e',
    }),
    probePortInUse: async () => false, // ports free
    requiredConfigFiles: ['package.json'],
  });
  const ids = new Set(report.checks.map(c => c.id));
  assert.ok(ids.has('docker_available') && ids.has('docker_compose_v2') && ids.has('memory_available'));
  // Internet reachability must be UNKNOWN (never claimed), never PASS.
  assert.equal(report.checks.find(c => c.id === 'internet_reachability')?.status, 'UNKNOWN');
  // Every verdict is one of the four allowed values.
  for (const c of report.checks) assert.ok(['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(c.status));
});

test('preflight: missing Docker is a blocking FAIL and makes it unsafe to proceed', async () => {
  const report = await runPreflight({
    repoRoot: REPO, minFreeMemGb: 0,
    runCommand: (cmd: string, _args: readonly string[]) => {
      if (cmd === 'docker') throw new Error('docker: command not found');
      if (cmd === 'git') return 'e5cc33f8068c6c2542ff298ea821899df56ab65e';
      throw new Error('no stub');
    },
    probePortInUse: async () => false,
    requiredConfigFiles: ['package.json'],
  });
  assert.equal(report.checks.find(c => c.id === 'docker_available')?.status, 'FAIL');
  assert.equal(report.safe_to_proceed, false);
  assert.equal(report.overall, 'FAIL');
});

test('preflight: a blocking UNKNOWN is never promoted to PASS (overall UNKNOWN, not safe)', async () => {
  const report = await runPreflight({
    repoRoot: REPO, minFreeMemGb: 0,
    expectedRevision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    runCommand: (cmd: string, args: readonly string[]) => {
      if (cmd === 'docker' && args[0] === 'version') return '29.8.0';
      if (cmd === 'docker' && args[0] === 'compose') return 'v2.39.1';
      if (cmd === 'git') throw new Error('git not available'); // expected_revision => UNKNOWN (blocking)
      throw new Error('no stub');
    },
    probePortInUse: async () => false,
    requiredConfigFiles: ['package.json'],
  });
  assert.equal(report.checks.find(c => c.id === 'expected_revision')?.status, 'UNKNOWN');
  assert.equal(report.overall, 'UNKNOWN');
  assert.equal(report.safe_to_proceed, false);
});

test('preflight: a port already in use is a blocking FAIL', async () => {
  const report = await runPreflight({
    repoRoot: REPO, minFreeMemGb: 0, requiredFreePorts: [443],
    runCommand: okCommand({ 'docker version': '29.8.0', 'docker compose version': 'v2.39.1', 'git -C': 'x' }),
    probePortInUse: async () => true,
    requiredConfigFiles: ['package.json'],
  });
  assert.equal(report.checks.find(c => c.id === 'port_443_free')?.status, 'FAIL');
  assert.equal(report.safe_to_proceed, false);
});

// ── Readiness aggregation ────────────────────────────────────────────────────────────────────────
function healthyGoLiveInput() {
  return {
    tenant_id: 'ten_pilot', deployment_ready: true, gate_available: true, sentinel_available: true,
    ledger_available: true, tenant_active: true, active_services: 1, reachable_mcp_servers: 1,
    enabled_tools: 1, tools_requiring_review: 0,
    bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: false },
    test_action_completed: true, backup_age_seconds: 10, max_backup_age_seconds: 86_400,
    allow_known_bypass_with_limitations: false,
  } satisfies Parameters<typeof assessGoLive>[0];
}
function passReport(): PreflightReport {
  return { checked_at: 't', host: { os: 'linux', hostname: 'pilot.example.com' }, checks: [], overall: 'PASS', safe_to_proceed: true };
}
function baseInputs(over: Partial<ReadinessInputs> = {}): ReadinessInputs {
  const action: GovernedActionEvidence = { request_id: 'req_1', gate_decision: 'ALLOW', capability_id: 'cap_1', sentinel_session_id: 'sess_1', result_hash: 'a'.repeat(64), final_state: 'COMPLETED', completed: true };
  return {
    deploymentId: 'dep_1', tenantId: 'ten_pilot', revision: 'e5cc33f', environment: 'staging',
    localRehearsal: false, preflight: passReport(), servicesHealthy: 'PASS', governedAction: action,
    restartCycles: { ran: 3, passed: 3 }, publicExposure: 'PASS', backup: 'BACKUP_VERIFIED',
    goLive: healthyGoLiveInput(), knownLimitations: [], ...over,
  };
}

test('readiness: a fully healthy real pilot can reach GO (nothing floors it)', () => {
  const r = aggregateReadiness(baseInputs());
  assert.equal(r.result, 'GO');
});

test('readiness: a failed governed action can NEVER read as PASS/GO', () => {
  const failedAction: GovernedActionEvidence = { request_id: 'req_x', gate_decision: 'HOLD', capability_id: null, sentinel_session_id: null, result_hash: null, final_state: 'HELD', completed: false };
  const r = aggregateReadiness(baseInputs({ governedAction: failedAction }));
  assert.equal(r.result, 'NO_GO');
});

test('readiness: a NOT_RUN governed action is INSUFFICIENT_EVIDENCE, never GO', () => {
  const r = aggregateReadiness(baseInputs({ governedAction: null }));
  assert.equal(r.result, 'INSUFFICIENT_EVIDENCE');
});

test('readiness: zero restart cycles cannot be GO (INSUFFICIENT_EVIDENCE)', () => {
  const r = aggregateReadiness(baseInputs({ restartCycles: { ran: 0, passed: 0 } }));
  assert.notEqual(r.result, 'GO');
  assert.equal(r.result, 'INSUFFICIENT_EVIDENCE');
});

test('readiness: a localhost rehearsal is capped at GO_WITH_LIMITATIONS, never a full GO', () => {
  const r = aggregateReadiness(baseInputs({ localRehearsal: true }));
  assert.equal(r.result, 'GO_WITH_LIMITATIONS');
});

test('readiness: a KNOWN_BYPASS (external direct credential) can never be a clean GO', () => {
  const goLive = { ...healthyGoLiveInput(), bypass_attestation: { tnaCredentialChain: false, externalDirectCredential: true } };
  const r = aggregateReadiness(baseInputs({ goLive }));
  assert.notEqual(r.result, 'GO');
});

test('readiness: NOT_RUN public exposure or backup caps below GO', () => {
  assert.notEqual(aggregateReadiness(baseInputs({ publicExposure: 'NOT_RUN' })).result, 'GO');
  assert.notEqual(aggregateReadiness(baseInputs({ backup: 'NOT_RUN' })).result, 'GO');
  assert.equal(aggregateReadiness(baseInputs({ backup: 'BACKUP_PROCEDURE_DOCUMENTED_NOT_AUTOMATED' })).result, 'GO_WITH_LIMITATIONS');
});

// ── Evidence package ─────────────────────────────────────────────────────────────────────────────
test('evidence package: builds, self-verifies, and detecting tamper fails verification', () => {
  const readiness = aggregateReadiness(baseInputs());
  const pkg = buildEvidencePackage({
    deploymentId: 'dep_1', gitCommit: 'e5cc33f', configHash: 'cfg', environment: 'staging',
    localRehearsal: false, preflight: passReport(), readiness, knownLimitations: ['Ledger/Auditor not separately deployed'],
  });
  assert.equal(verifyEvidencePackage(pkg), true);
  const tampered = { ...pkg, environment: 'production' };
  assert.equal(verifyEvidencePackage(tampered), false);
});

test('evidence package: refuses to build if secret-shaped content is present', () => {
  const readiness = aggregateReadiness(baseInputs());
  // A bearer-token-shaped VALUE built at runtime (no secret literal in source) must be refused.
  const bearerValue = 'Bearer ' + 'x'.repeat(20);
  assert.throws(() => buildEvidencePackage({
    deploymentId: 'dep_1', gitCommit: 'e5cc33f', configHash: 'cfg', environment: 'staging',
    localRehearsal: false, preflight: passReport(), readiness,
    knownLimitations: ['leaked value: ' + bearerValue],
  }), /secret-shaped/);
});

test('evidence secret scan: detects secret-shaped keys at any depth and passes clean data', () => {
  // Detection keys on the FIELD NAME, independent of the (here-innocuous) value.
  assert.ok(findSecretShaped({ nested: { authorization: 'innocuous' } }));
  assert.ok(findSecretShaped({ a: [{ password: 'innocuous' }] }));
  assert.ok(findSecretShaped({ b: { api_key: 'innocuous' } }));
  // A bearer-pattern VALUE under an innocuous key is also detected (built at runtime, no source literal).
  assert.ok(findSecretShaped({ note: 'Bearer ' + 'y'.repeat(16) }));
  assert.equal(findSecretShaped({ ok: 'plain', count: 3, nested: { fine: true } }), null);
});
