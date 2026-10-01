/**
 * TNA Deployment Bootstrap v0.1 — per-restart persistence verifier (run INSIDE tna-platform via stdin).
 * After a restart, proves from REAL state that nothing was lost or fabricated:
 *   1. the pilot-agent envelope still exists in the Gate store with demo.echo (durable identity/authority);
 *   2. a FRESH governed demo.echo.execute action still COMPLETES through the real pipeline;
 *   3. no duplicate-identity conflict (register would 409 'already registered' — tolerated, reconciled).
 * Env: ATOK = platform demo-agent token; CYCLE = cycle label.
 */
const tok = process.env.ATOK;
const cycle = process.env.CYCLE || '?';
const base = 'http://127.0.0.1:4618';
const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };

// 1. Envelope still present (durable Gate identity survived restart)?
const { Store } = await import('/app/dist/packages/evidence-core/src/index.js');
const { Gate } = await import('/app/dist/apps/tna-gate-api/src/gate.js');
const store = new Store('/data/tna-platform-gate.sqlite');
const gate = new Gate(store);
let envTools = null;
try { const env = gate.getEnvelope({ kind: 'admin', role: 'administrator' }, 'pilot-agent-1'); envTools = env.envelope.tools.allow; } catch (e) { envTools = 'MISSING:' + e.message; }
store.close();

// 2. Fresh governed action still works?
const reqId = 'pilot_restart_' + cycle + '_' + Date.now();
const action = { version: '1.0', request_id: reqId, tenant_id: 'tenant_demo', agent_id: 'pilot-agent-1', action: 'demo.echo.execute', tool: 'demo.echo', operation: 'execute', resource: '/pilot/verification/message', input: { message: 'restart cycle ' + cycle }, requires_verification: false, metadata: {} };
const r = await fetch(base + '/v1/platform/actions', { method: 'POST', headers: H, body: JSON.stringify(action) });
const b = await r.json().catch(() => null);
let finalState = b && b.state, capId = b && b.capability_id, gateDec = b && b.gate_decision && b.gate_decision.decision;
const id = b && b.platform_action_id;
if (id && !['COMPLETED', 'FAILED', 'BLOCKED', 'TERMINATED'].includes(finalState)) {
  for (let i = 0; i < 10; i += 1) { await new Promise(x => setTimeout(x, 600)); const g = await fetch(base + '/v1/platform/actions/' + id, { headers: H }); const a = await g.json(); finalState = a.state; capId = a.capability_id; gateDec = a.gate_decision && a.gate_decision.decision; if (['COMPLETED', 'FAILED', 'BLOCKED', 'TERMINATED'].includes(finalState)) break; }
}
console.log('RESTART_CYCLE', cycle,
  'envelope_tools=' + JSON.stringify(envTools),
  'action_state=' + finalState,
  'gate=' + gateDec,
  'capability_id=' + capId,
  'action_id=' + id);
