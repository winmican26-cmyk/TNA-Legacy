/**
 * TNA Deployment Bootstrap v0.1 — pilot platform-agent envelope installer (run INSIDE the tna-platform
 * container via stdin: `... exec -T tna-platform node --input-type=module < this-file`).
 *
 * Reuses the ACCEPTED frozen Gate API (register + setEnvelope) with the exact accepted pilot envelope
 * from scripts/pilot-bootstrap-platform-agent.ts (pilotEnvelope). It invents no authority: the envelope
 * allows only `demo.echo` / `demo.echo.execute`, LOW risk, no approvals. Fail-closed on any non-409
 * register error (never a partially-bootstrapped identity). Re-reads the envelope to PROVE it installed —
 * the exit code alone is not treated as proof.
 *
 * Agent id/name come from env AID/ANAME (default pilot-agent-1). Gate store path from TNA_PILOT_GATE_DB_PATH
 * (default /data/tna-platform-gate.sqlite).
 */
const AID = process.env.AID || 'pilot-agent-1';
const ANAME = process.env.ANAME || 'Pilot Agent 1';
const DB = process.env.TNA_PILOT_GATE_DB_PATH || '/data/tna-platform-gate.sqlite';

const { Store } = await import('/app/dist/packages/evidence-core/src/index.js');
const { Gate, HttpError } = await import('/app/dist/apps/tna-gate-api/src/gate.js');

const nowIso = (o = 0) => new Date(Date.now() + o).toISOString();
const envelope = {
  version: '1.0',
  agent: { id: AID, name: ANAME, role: 'pilot', owner: 'pilot-operator', environment: 'pilot', expires_at: nowIso(365 * 24 * 3600_000) },
  objective: { task_id: 'pilot-verification', goal: 'Demonstrate end-to-end pilot governed action', allowed_outcomes: ['echo a pilot verification message'], forbidden_outcomes: [] },
  resources: { repositories: { read: [], write: [] }, files: { read: ['/pilot/verification/**'], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
  tools: { allow: ['demo.echo'], deny: ['shell.unrestricted'] },
  network: { allow: [], deny: ['*'] },
  secrets: { allow: [], deny: ['*'] },
  agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
  limits: { max_runtime_seconds: 600, max_tool_calls: 40, max_external_requests: 0, max_cost_usd: 3, max_retries_per_action: 5 },
  approvals: { required_for: [] },
  risk: { level: 'low', blast_radius: 'none', rollback_required: false },
  evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'], retention_days: 365 },
  violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
  action_bindings: [{ action: 'demo.echo.execute', outcome: 'echo a pilot verification message', tool: 'demo.echo', resource_kind: 'files', operation: 'read', destination_required: false }],
};

const store = new Store(DB);
const gate = new Gate(store);
const admin = { kind: 'admin', role: 'administrator' };
let outcome;
try {
  gate.register(admin, { id: AID, name: ANAME });
  outcome = 'registered';
} catch (e) {
  if (e instanceof HttpError && e.status === 409 && e.message === 'Agent already registered') outcome = 'already-registered';
  else { console.log('REGISTER_ERR', e && e.message ? e.message : String(e)); store.close(); process.exit(1); }
}
gate.setEnvelope(admin, envelope);
const check = gate.getEnvelope(admin, AID);
console.log('BOOTSTRAP', outcome, 'envelope_tools=' + JSON.stringify(check.envelope.tools.allow));
store.close();
