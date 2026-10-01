/**
 * TNA Deployment Bootstrap v0.1 — ONE real governed action through the accepted Platform (run INSIDE the
 * tna-platform container via stdin). Submits `demo.echo.execute` (the shipped safe demo tool, bound to
 * tenant_demo) as the bootstrapped pilot-agent-1, then reads back the REAL action record and prints the
 * authoritative evidence identifiers. No value is fabricated — every field is read from the Platform's
 * own action record / Gate decision.
 *
 * Env: ATOK = platform demo-agent bearer token; REQID = caller request id.
 */
const tok = process.env.ATOK;
const reqId = process.env.REQID;
const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
const base = 'http://127.0.0.1:4618';
const action = {
  version: '1.0',
  request_id: reqId,
  tenant_id: 'tenant_demo',
  agent_id: 'pilot-agent-1',
  action: 'demo.echo.execute',
  tool: 'demo.echo',
  operation: 'execute',
  resource: '/pilot/verification/message',
  input: { message: 'pilot verification' },
  requires_verification: false,
  metadata: {},
};

const r = await fetch(base + '/v1/platform/actions', { method: 'POST', headers: H, body: JSON.stringify(action) });
const submitted = await r.json().catch(() => null);
console.log('SUBMIT', r.status, 'state=' + (submitted && submitted.state), 'platform_action_id=' + (submitted && submitted.platform_action_id));
if (submitted && submitted.gate_decision) console.log('SUBMIT_GATE', submitted.gate_decision.decision, 'reason=' + (submitted.gate_decision.reason || ''));

const id = submitted && submitted.platform_action_id;
if (id) {
  // Poll briefly for the terminal state (the platform runs the governed pipeline asynchronously).
  let a = null;
  for (let i = 0; i < 10; i += 1) {
    await new Promise(x => setTimeout(x, 600));
    const g = await fetch(base + '/v1/platform/actions/' + id, { headers: H });
    a = await g.json();
    if (['COMPLETED', 'FAILED', 'BLOCKED', 'TERMINATED', 'INDETERMINATE'].includes(a.state)) break;
  }
  console.log('ACTION',
    'state=' + a.state,
    'gate=' + (a.gate_decision && a.gate_decision.decision),
    'decision_id=' + (a.gate_decision && a.gate_decision.decision_id),
    'capability_id=' + a.capability_id,
    'sentinel_session_id=' + a.sentinel_session_id,
    'execution_id=' + a.execution_id,
    'result_hash=' + a.result_hash,
    'error_code=' + a.error_code,
  );
}
