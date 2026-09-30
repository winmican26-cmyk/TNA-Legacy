# TNA Vendor Authority Adapter v0.1 — Threat Model

**Status:** Implementation-backed, tested governed path, documented limitations

---

## 1. Threat Model Scope

This threat model covers the **Vendor Authority Adapter v0.1** integration path:

```
Vendor Runtime → Adapter → Platform → Gate → Capability → Sentinel → Broker → Tool
```

**Core invariant under threat:**
> A MODEL MAY PROPOSE AN ACTION. IT MUST NOT POSSESS AN ALTERNATE PATH THAT CAN PRODUCE THE SAME CONSEQUENTIAL EFFECT OUTSIDE THE GOVERNED EXECUTION BOUNDARY.

---

## 2. Asset Inventory

| Asset | Classification | Description |
|-------|----------------|-------------|
| Downstream credentials (deploy keys, cloud creds, Git tokens) | `SECRET_REFERENCE` | Leased by SecretBroker at execution time only |
| Gate decisions (ALLOW/BLOCK/HOLD) | `CONFIDENTIAL` | Authoritative authorization evidence |
| Capability tokens | `SECRET_REFERENCE` | HMAC-SHA256 signed, single-use, 30s TTL |
| Vendor session state | `INTERNAL` | Session authority envelope, tool call history |
| Ledger events with vendor provenance | `CONFIDENTIAL` | Causal chain for audit/reconstruction |
| Sentinel session/containment state | `INTERNAL` | Monitoring, hold, terminate decisions |

---

## 3. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                    TNA CONTROL PLANE                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────────┐  │
│  │ Platform│  │  Gate   │  │Sentinel │  │   Broker     │  │
│  └────┬────┘  └────┬────┘  └────┬────┘  └──────┬───────┘  │
└───────┼────────────┼────────────┼────────────┼────────────┘
        │            │            │            │
        ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────┐
│                   ADAPTER LAYER                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ VendorAdapterRuntime (mediation, normalization)       │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ VendorAdapter (Anthropic / OpenAI / xAI)             │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                   VENDOR RUNTIME (UNTRUSTED)                 │
│  Anthropic SDK / OpenAI SDK / xAI SDK / Custom Agent        │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** Vendor runtime is **untrusted**. All authorization decisions made inside TNA control plane.

---

## 4. Threat Enumeration (STRIDE)

### S — Spoofing

| Threat | Mitigation | Test |
|--------|------------|------|
| Agent spoofs vendor session ID | Session ID bound to capability + Sentinel session | `wrong session` abuse test |
| Agent spoofs vendor tool call ID | Exact-call capability binds `vendor_tool_call_id` | `changed args after ALLOW` test |
| Agent spoofs tenant identity | Platform principal validated at submission | `wrong tenant` abuse test |
| Vendor SDK returns forged provenance | Provenance recorded at broker/Ledger, not from vendor | Provenance correlation test |

### T — Tampering

| Threat | Mitigation | Test |
|--------|------------|------|
| Agent modifies args after Gate ALLOW | Capability binds `input_hash`; broker validates at redeem | `changed args after ALLOW` → BLOCK |
| Agent reuses capability | Single-use enforcement in broker (`consumed` flag) | `reused capability` abuse test |
| Agent replays vendor tool call | Capability TTL (30s) + nonce + broker single-use | `tool-call replay` abuse test |
| Agent modifies Ledger events | Ledger append-only, hash-chained, causation_id fixed at enqueue | Ledger integrity tests |
| Sentinel decision tampered | Sentinel CAS writes, status reconciliation, containment confirmation | Sentinel concurrency tests |

### R — Repudiation

| Threat | Mitigation | Test |
|--------|------------|------|
| Vendor denies tool call execution | Vendor provenance in Ledger (request_id, tool_call_id, model) | Ledger reconstruction test |
| Agent denies session authority | Session authority recorded at session start | Session authority audit test |
| Human approver denies approval | Gate decision includes `approval_reference` | Gate decision audit test |

### I — Information Disclosure

| Threat | Mitigation | Test |
|--------|------------|------|
| Credentials leaked to agent | Credentials only leased at redeem, never to agent | `secret access fails closed without broker` test |
| Vendor API keys in Ledger | Ledger secret detector rejects secret-shaped fields | Ledger secret detection test |
| Cross-tenant data exposure | Tenant isolation at Platform, Sentinel, Ledger, Broker | `cross-tenant` abuse test |

### D — Denial of Service

| Threat | Mitigation | Test |
|--------|------------|------|
| Gate outage blocks all actions | Fail-closed (by design) — no silent fallback | `Gate unavailable` test |
| Sentinel unavailable | Session creation fails → action INDETERMINATE | `Sentinel unavailable` test |
| Broker credential lease timeout | Bounded leases, automatic release | Execution broker tests |
| Vendor SDK hangs | Adapter timeouts, Sentinel heartbeat | Timeout tests |

### E — Elevation of Privilege

| Threat | Mitigation | Test |
|--------|------------|------|
| Agent uses session authority for unauthorized call | Exact-call capability required per action; session authority ≠ call authority | `session authority broader than call authority` test |
| Agent bypasses broker via direct credentials | Credentials only in SecretBroker, leased at redeem | `credential bypass attempt` test |
| Model widens policy via prompt injection | Policy operates on normalized action, not vendor JSON | `model cannot widen policy` test |
| Agent escalates via capability substitution | Capability binds exact `input_hash`, `vendor_tool_call_id` | `capability substitution` test |

---

## 5. Critical Attack Vectors (Tested)

### 5.1 Credential Bypass (Section 6 — Mandatory)

**Invariant:** THE AGENT MUST NOT RETAIN AN ALTERNATE CREDENTIAL PATH THAT CAN PRODUCE THE SAME CONSEQUENTIAL EFFECT OUTSIDE TNA.

**Tested vectors (all BLOCKED):**
1. Direct tool invocation outside adapter → BLOCKED
2. Credential reuse across sessions → BLOCKED  
3. Session authority broader than call authority → BLOCKED
4. Model cannot widen policy → BLOCKED
5. Downstream credential removed from broker → action cannot execute
6. Agent given no alternate credential → bypass path absent for tested effect

### 5.2 Argument Substitution After Approval

**Threat:** Agent obtains ALLOW for `deploy(commit=A)`, substitutes `deploy(commit=B)`.

**Mitigation:** Exact-call capability binds:
- `input_hash` (SHA256 of canonical action)
- `vendor_tool_call_id` (vendor-specific correlation)
- Single-use, 30s TTL, HMAC-SHA256 signed

**Test:** `changed args after ALLOW` → capability validation fails → BLOCK

### 5.3 Capability Replay

**Threat:** Agent captures capability token and replays it.

**Mitigation:**
- Single-use (`consumed` flag in broker)
- 30s TTL (configurable, max 60s)
- Nonce (16 random bytes)
- Bound to specific `execution_id`, `decision_id`, `agent_id`

**Test:** `reused capability` → broker rejects → BLOCK

### 5.4 Cross-Tenant Action

**Threat:** Agent in tenant A executes action scoped to tenant B.

**Mitigation:**
- Platform principal validates `tenantId` at submission
- Sentinel principal validates tenant at session creation
- Broker principal validates agent ownership
- Ledger tenant_id in every event

**Test:** `wrong tenant` → FORBIDDEN at multiple layers

---

## 6. Vendor-Specific Threats

### Anthropic/Claude (Test Harness)

| Threat | Status | Notes |
|--------|--------|-------|
| No pre-tool hook in SDK | **DOCUMENTED LIMITATION** | Test harness simulates; real hook needed for production |
| No cancellation boundary | **DOCUMENTED LIMITATION** | `cancel_unavailable` reported honestly |
| Session lifecycle not observable | **DOCUMENTED LIMITATION** | Harness provides simulated events |

### OpenAI / xAI

| Threat | Status | Notes |
|--------|--------|-------|
| No real adapter | **NOT_IMPLEMENTED** | Stub adapters throw `VENDOR_UNSUPPORTED` |
| Future SDK hooks unknown | **TRACKED** | Will evaluate when SDKs expose pre-tool hooks |

---

## 7. Residual Risks (Accepted)

| Risk | Acceptance Rationale |
|------|---------------------|
| Vendor SDK may execute tool before TNA intercepts | **Accepted for v0.1** — Anthropic SDK lacks pre-tool hook; test harness documents gap. Production deployment requires SDK with hook. |
| Sentinel containment cannot reverse external effects | **By design** — `CONTAINMENT_UNCONFIRMED` recorded honestly; never claim reversal |
| Vendor usage telemetry may be inaccurate | **Supplemental only** — not used for policy decisions in v0.1 |
| Computer-use actions (GUI) lack semantic binding | **Accepted** — conservative HOLD for high-risk irreversible GUI actions; pixels are not authority |

---

## 8. Security Test Coverage

| Test Category | Count | Status |
|---------------|-------|--------|
| Credential bypass attempts | 6 | ✅ All BLOCKED |
| Argument substitution | 2 | ✅ BLOCKED |
| Capability replay | 2 | ✅ BLOCKED |
| Cross-tenant | 1 | ✅ FORBIDDEN |
| Gate/Sentinel unavailable | 3 | ✅ FAIL CLOSED |
| Session cancellation | 3 | ✅ VERIFIED |
| Malformed vendor events | 2 | ✅ REJECTED |
| Tool-call replay | 1 | ✅ BLOCKED |

**Total abuse/negative tests: 16+** (per spec Section 16)

---

## 9. Detection & Response

| Detection | Response |
|-----------|----------|
| Capability validation failure | Alert, audit trail, block action |
| Sentinel TERMINATE/HOLD | Immediate containment, Ledger event |
| Credential lease failure | Action fails, audit, investigate |
| Cross-tenant access attempt | Immediate block, incident creation |
| Vendor SDK anomaly (timeout, crash) | Sentinel INDETERMINATE, Ledger event |

---

## 10. Assumptions

1. TNA control plane (Platform, Gate, Sentinel, Broker, Ledger) is trusted and uncompromised
2. SecretBroker correctly isolates credentials per execution
3. SQLite WAL mode provides durability for Sentinel/Ledger/Platform stores
4. Vendor SDK runs in same trust domain as adapter (no network boundary assumed)
5. Human approval workflow (for HELD actions) is out of scope for this threat model

---

## 11. References

- [TNA Vendor Authority Adapter v0.1 Spec](./vendor-authority-adapter-v0.1.md)
- [Gap Analysis](./vendor-authority-adapter-gap-analysis-v0.1.md)
- [Verification Plan](./vendor-authority-adapter-verification-v0.1.md)
- [Proof of Work](./vendor-authority-adapter-proof-of-work-v0.1.md)
- TNA Sentinel v0.1 Threat Model (Volume 6)
- TNA Platform Integration Threat Model (Volume 8)
- TNA Client Integration Threat Model (Volume 10)