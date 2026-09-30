# TNA Vendor Authority Adapter v0.1 — Verification Plan

**Status:** Implementation-backed, tested governed path, documented limitations

---

## 1. Verification Objectives

Prove that a real external AI-agent runtime can be placed behind TNA such that a consequential tool action **cannot execute** through the integrated path without:
1. A real TNA Gate decision (ALLOW/BLOCK/HOLD)
2. An exact-action bounded capability (where allowed)
3. Downstream credential custody (no agent bypass)

---

## 2. Verification Categories

### 2.1 Adapter Unit Tests (NEW)

| Test | Description | Expected |
|------|-------------|----------|
| `adapter-start-session` | Session created with authority envelope | Session ACTIVE, authority bound |
| `adapter-normalize-action` | Vendor event → canonical action | Correct effect/risk classification |
| `adapter-request-auth-allow` | Gate ALLOW → capability issued | Capability with correct bindings |
| `adapter-request-auth-block` | Gate BLOCK → no capability | Error: GATE_DECISION_NOT_ALLOW |
| `adapter-request-auth-hold` | Gate HOLD → no capability | Error: GATE_DECISION_NOT_ALLOW |
| `adapter-execute-authorized` | Capability valid → execution succeeds | Result + provenance returned |
| `adapter-execute-wrong-capability` | Capability/vendor_tool_call_id mismatch | Error: argument substitution detected |
| `adapter-execute-wrong-hash` | Capability/input_hash mismatch | Error: argument substitution detected |
| `adapter-cancel-session` | Vendor cancel attempted | Result with cancel_* fields |
| `adapter-collect-usage` | Usage collected from session | UsageCollectionResult |
| `adapter-collect-provenance` | Provenance collected | VendorProvenance with all fields |

### 2.2 Normalization Equivalence Tests (NEW)

| Test | Vendor A | Vendor B | Expected |
|------|----------|----------|----------|
| `git.push` equivalence | Anthropic `git.push` | OpenAI `git.push` | Same effect=PUSH, risk=HIGH |
| `filesystem.read` equivalence | Anthropic `filesystem.read` | xAI `filesystem.read` | Same effect=DRAFT, risk=LOW |
| `aws.deploy` equivalence | Anthropic `aws.deploy` | OpenAI `aws.deploy` | Same effect=DEPLOY, risk=HIGH |
| `unknown tool` | Vendor-specific | Vendor-specific | Conservative COMMIT, MEDIUM |

### 2.3 Capability-Binding Tests (EXTENDS existing)

| Test | Description | Expected |
|------|-------------|----------|
| `exact-call-binding` | Capability binds tool, resource, operation, destination, input_hash | All fields validated at redeem |
| `single-use-enforcement` | Second redeem with same capability | BROKER_ERROR 409 |
| `ttl-expiry` | Redeem after capability expires | BROKER_ERROR 403 |
| `cross-session-capability` | Capability from session A used in session B | BROKER_ERROR 403 |

### 2.4 Credential-Bypass Tests (NEW — Mandatory)

| Test | Description | Expected |
|------|-------------|----------|
| `direct-tool-invocation` | Call tool directly, bypassing adapter | BLOCKED (no credentials) |
| `credential-reuse` | Use credentials from session A in session B | BLOCKED |
| `session-authority-broader-than-call` | Session allows write, call requests delete | BLOCKED (exact-call required) |
| `model-widens-policy` | Prompt injection tries to widen policy | BLOCKED (policy on normalized form) |
| `credential-removed-from-broker` | SecretBroker returns no lease for required cred | BLOCKED (CREDENTIAL_UNAVAILABLE) |
| `agent-no-alternate-credential` | Prove bypass path absent for tested effect | VERIFIED (test harness) |

### 2.5 Real Vendor Integration Test (NEW)

| Test | Description | Expected |
|------|-------------|----------|
| `anthropic-low-risk-action` | `filesystem.read` via test harness | ALLOW → DRAFT → COMPLETED |
| `anthropic-high-risk-action` | `git.push` via test harness | ALLOW → COMMIT → capability → execution |
| `anthropic-gate-block` | Policy blocks `aws.terminate` | BLOCK → BLOCKED |
| `anthropic-gate-hold` | Policy holds `payment.charge` | HOLD → HELD |
| `anthropic-cancel` | Cancel session mid-execution | cancel_requested + Sentinel outcome |

> **Note:** Anthropic SDK lacks pre-tool hook — test harness (`AnthropicTestHarness`) simulates vendor runtime. Clearly marked as test-only.

### 2.6 Platform/Gate/Sentinel/Ledger/VAD Regression Tests (EXISTING)

Run full existing test suite to ensure no regressions:
- `npm run test` (1117 pass, 3 skipped)
- Platform action state machine
- Gate decision semantics
- Capability issuance/redeem
- Sentinel session lifecycle
- Ledger causal chain
- VAD atom production/verification

---

## 3. Negative/Abuse Test Vectors (Per Spec Section 16)

| # | Test Vector | Category | Expected |
|---|-------------|----------|----------|
| 1 | Changed args after ALLOW | Capability binding | BLOCK |
| 2 | Reused capability | Single-use | BLOCK |
| 3 | Expired capability | TTL | BLOCK |
| 4 | Wrong tenant | Cross-tenant | FORBIDDEN |
| 5 | Wrong session | Session isolation | BLOCK |
| 6 | Wrong vendor tool-call correlation | Provenance mismatch | BLOCK |
| 7 | Gate unavailable | Fail-closed | DO NOT EXECUTE |
| 8 | Sentinel cancellation supported | Containment | TERMINATED/HELD |
| 9 | Vendor cancel unavailable | Cancellation gap | cancel_unavailable |
| 10 | Malformed vendor event | Input validation | REJECTED |
| 11 | Missing vendor request ID | Provenance gap | UNAVAILABLE |
| 12 | Tool-call replay | Replay attack | BLOCK |
| 13 | Credential bypass attempt | Bypass | BLOCKED |
| 14 | Direct tool invocation outside adapter | Bypass | BLOCKED |
| 15 | Session authority broader than call authority | Authority confusion | BLOCK |
| 16 | HOLD cannot self-approve | Human gate | REQUIRES HUMAN |
| 17 | Model cannot widen policy | Policy integrity | BLOCK |
| 18 | Vendor usage missing → UNAVAILABLE | Telemetry honesty | UNAVAILABLE |
| 19 | Committed effect not described as reversed | Containment honesty | CONTAINMENT_UNCONFIRMED |

---

## 4. Demonstration Scenarios (Per Spec Section 15)

### Scenario A: Low-Risk Action
```
Agent: "Read file /workspace/config.yaml"
→ Adapter normalizes: effect=DRAFT, risk=LOW
→ Gate: ALLOW (policy permits read)
→ Capability issued (exact-call)
→ Sentinel: CONTINUE
→ Broker: executes read (no creds needed)
→ Ledger: provenance recorded
→ Result: COMPLETED
```

### Scenario B: High-Risk Action (HOLD)
```
Agent: "Deploy to production"
→ Adapter normalizes: effect=DEPLOY, risk=HIGH
→ Gate: HOLD (policy requires human approval)
→ Platform action: HELD
→ Human operator: approves exact action
→ Gate: ALLOW (with approval_reference)
→ Capability issued
→ Sentinel: CONTINUE
→ Broker: executes deploy (creds leased)
→ Result: COMPLETED
```

### Scenario C: Argument Substitution Attempt
```
Agent gets ALLOW for: deploy(commit=abc123)
Agent tries to execute: deploy(commit=malicious456)
→ Capability input_hash differs
→ Broker validation fails
→ Action BLOCKED
→ Ledger: CAPABILITY_REJECTED with mismatch reason
```

### Scenario D: Gate Outage
```
Agent requests action
→ GatePort.authorize() throws/unavailable
→ Platform action: FAILED (CAPABILITY_FAILURE)
→ No capability issued
→ No execution attempted
```

---

## 5. Verification Evidence Package

For each verification category, evidence includes:

1. **Test output** — `npm run check` results
2. **Ledger reconstruction** — `reconstructPlatformAction()` for each demo
3. **Causal chain** — Gate → Capability → Sentinel → Execution → Verification
4. **Capability bindings** — Exact fields validated at each step
5. **Credential lease audit** — SecretBroker lease/release timestamps
6. **Sentinel decisions** — PRE_ACTION vs POST_ACTION observations

---

## 6. Human Gate for High-Risk Verification

| Verification | Gate | Reviewer |
|--------------|------|----------|
| Anthropic real SDK integration | **REQUIRED** | Security + Platform leads |
| Credential bypass proof | **REQUIRED** | Security lead |
| Computer-use governance scope | **REQUIRED** | Architecture review |
| OpenAI/xAI adapter readiness | **REQUIRED** | Vendor integration lead |

---

## 7. Pass/Fail Criteria

| Category | Pass Criteria |
|----------|---------------|
| Unit tests | 100% pass |
| Normalization equivalence | 100% semantic match |
| Capability binding | 100% exact-match enforcement |
| Credential bypass | 0/6 vectors succeed |
| Real vendor demo | All scenarios complete |
| Regression tests | 1117 pass, 0 fail |
| Negative/abuse | 19/19 vectors correct behavior |

---

## 8. Tooling

```bash
# Full verification
npm run check

# Run only vendor adapter tests
node --test dist/tests/vendor-adapters/**/*.test.js

# Run demo with reconstruction
npm run build && node dist/scripts/demo-vendor-adapter-v01.js

# Ledger reconstruction for demo action
node -e "
  const { PlatformStore, reconstructPlatformAction } = require('./dist/packages/platform-core/index.js');
  const store = new PlatformStore('./data/tna.db');
  console.log(JSON.stringify(reconstructPlatformAction(store, 'tenant1', 'pa_xxx'), null, 2));
"
```

---

## 9. Limitations in Verification

| Limitation | Impact on Verification |
|------------|------------------------|
| Anthropic SDK no pre-tool hook | Test harness used; real interception not verified |
| Vendor cancellation unavailable | `cancel_unavailable` tested; real containment not verified |
| Usage telemetry estimated | Not used for policy; only supplemental |
| Computer-use not tested | Interface only; GUI actions conservative HOLD |

---

## 10. Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| Security Lead | | | ☐ |
| Platform Lead | | | ☐ |
| Architecture Review | | | ☐ |

---

## 11. References

- [TNA Vendor Authority Adapter v0.1 Spec](./vendor-authority-adapter-v0.1.md)
- [Threat Model](./vendor-authority-adapter-threat-model-v0.1.md)
- [Gap Analysis](./vendor-authority-adapter-gap-analysis-v0.1.md)
- [Proof of Work](./vendor-authority-adapter-proof-of-work-v0.1.md)