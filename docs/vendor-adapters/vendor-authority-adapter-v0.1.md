# TNA Vendor Authority Adapter v0.1

**Status:** Implementation-backed, tested governed path, documented limitations

---

## 1. Overview

This document specifies the **TNA Vendor Authority Adapter v0.1** — a vendor-neutral contract and runtime for placing real external AI-agent runtimes behind TNA such that a consequential tool action cannot execute through the integrated path without first receiving a real TNA Gate decision and, where allowed, an exact-action bounded capability.

### Architectural Invariant

> **A MODEL MAY PROPOSE AN ACTION. IT MUST NOT POSSESS AN ALTERNATE PATH THAT CAN PRODUCE THE SAME CONSEQUENTIAL EFFECT OUTSIDE THE GOVERNED EXECUTION BOUNDARY.**

> **A CAPABILITY AUTHORIZES AN ACTION. IT DOES NOT CERTIFY THAT THE ACTION IS WISE, CORRECT, SAFE, OR SUCCESSFUL.**

---

## 2. Scope

### In Scope (v0.1)
- One canonical vendor-neutral adapter contract (`VendorAdapter`)
- Canonical action normalization (vendor-specific → TNA semantic fields)
- Session authority (broad envelope) + Exact-call capability (per-action binding)
- Downstream credential custody via `ExecutionBroker` + `SecretBroker` (no agent bypass)
- **One real vendor adapter:** Anthropic/Claude (test harness — see Limitations)
- Real vendor model producer alongside `DeterministicMockProducer`
- Vendor provenance in Ledger (`AuthorityContext`, `ExecutionContext` extensions)
- Sentinel cancellation/containment integration (`cancelVendorSessionWithSentinel`)
- Draft vs Commit effect classification (risk-based, not blanket HOLD)
- Usage/budget telemetry capture (supplemental)
- Fail-closed behavior for consequential actions
- Negative/abuse test suite (16 test vectors)
- Stub adapters for OpenAI and xAI (`NOT_IMPLEMENTED`)

### Out of Scope (v0.1)
- Universal computer-use governance (pixels are not authority)
- OpenAI / xAI real integrations (stub only)
- Vendor SDK pre-tool hooks that don't exist yet
- Deployment Bootstrap & Readiness (Volume 14)

---

## 3. Vendor-Neutral Adapter Contract

### Core Interface: `VendorAdapter`

```typescript
interface VendorAdapter {
  // Session lifecycle
  startSession(input: StartSessionInput): Promise<VendorSession>;
  cancelSession(vendor_session_id: string): Promise<CancellationResult>;
  closeSession(vendor_session_id: string): Promise<void>;

  // Translation & mediation
  normalizeAction(event: VendorToolCallEvent): NormalizationResult;
  requestAuthorization(input: AuthorizationRequestInput): Promise<AuthorizationResult>;
  executeAuthorizedCall(input: ExecutionInput): Promise<AuthorizedCallResult>;

  // Observability
  collectUsage(vendor_session_id: string): Promise<UsageCollectionResult>;
  collectVendorProvenance(vendor_session_id: string): Promise<VendorProvenance>;
}
```

**Primary responsibility:** Translation and lifecycle mediation.  
**TNA remains authoritative** for authorization (Gate), capability issuance (Broker), and monitoring (Sentinel).

### Session Authority vs Exact-Call Capability

| Concept | Purpose | Scope |
|---------|---------|-------|
| **Session Authority** | Broad maximum authority for one agent run | Tools, resources, operations, destinations, budget, TTL |
| **Exact-Call Capability** | Bounded capability for ONE real action | Single tool, resource, operation, input_hash, 30s TTL, single-use |

The agent **cannot** obtain approval for `deploy(commit=A)` and substitute `deploy(commit=B)` — the capability binds to the exact `input_hash`.

---

## 4. Canonical Action Normalization

All vendor tool calls normalize to `CanonicalAction`:

```typescript
interface CanonicalAction {
  // Vendor identification
  vendor: string;
  vendor_session_id: string;
  vendor_request_id: string;
  vendor_tool_call_id: string | null;

  // Tenant/principal/agent identity
  tenant: string;
  principal: string;
  agent_identity: string;

  // Action semantics
  tool: string;
  operation: string;
  resource: string;
  destination: string | null;
  argv: Record<string, unknown>;
  paths: readonly string[];
  effect: EffectClass;  // DRAFT | PREVIEW | GENERATE | COMMIT | SEND | POST | PAY | PUSH | DEPLOY | DELETE

  // Risk and budget
  risk_class: RiskClass;  // LOW | MEDIUM | HIGH | CRITICAL
  input_hash: string;
  requested_budget: { max_cost_usd: number; max_runtime_seconds: number };

  // Provenance (not for policy evaluation)
  vendor_raw_request: Record<string, unknown>;
}
```

**Policy operates on this semantic form only** — never on arbitrary vendor JSON.  
Equivalent actions from different vendors produce equivalent TNA policy semantics.

### Effect Classification (Section 11)

| Effect | Examples | Default Budget |
|--------|----------|----------------|
| `DRAFT` / `PREVIEW` / `GENERATE` | `git.diff`, `filesystem.read`, `github.list` | $0.10 / 30s |
| `COMMIT` / `SEND` / `POST` / `PUSH` | `git.push`, `email.send`, `webhook.post` | $0.50–1.00 / 60s |
| `DEPLOY` | `aws.deploy`, `kubernetes.apply`, `docker.deploy` | $2.00 / 300s |
| `DELETE` / `PAY` | `database.drop`, `payment.charge`, `github.delete` | $1.00 / 60s |

**Conservative default:** Unknown operations → `COMMIT` (requires Gate authorization).

---

## 5. Downstream Credential Custody (No Bypass)

**Invariant:** The agent must not retain an alternate credential path that can produce the same consequential effect outside TNA.

### Mechanism
1. Credentials are **never** given to the agent or vendor SDK
2. `ExecutionBroker.redeem()` leases credentials via `SecretBroker` **at execution time only**
3. Credentials are released immediately after execution (`finally` block)
4. If broker has no credentials → action fails (`CREDENTIAL_UNAVAILABLE`)
5. If agent has credentials independently → **bypass detected** (tested in abuse suite)

### Tested Bypass Vectors (All BLOCKED)
- Direct tool invocation outside adapter
- Credential reuse across sessions
- Session authority broader than call authority
- Model cannot widen policy

---

## 6. First Real Vendor: Anthropic/Claude

### Implementation Status
- **Adapter:** `AnthropicAdapter` in `packages/vendor-adapter-core/src/anthropic-adapter.ts`
- **Test Harness:** `AnthropicTestHarness` simulates vendor runtime for demonstration
- **Real SDK:** `@anthropic-ai/sdk` **NOT installed** — no pre-tool authorization hook exists

### Documented Limitations (Per Spec Section 7)

> The official Anthropic SDK and Agent SDK do not currently expose a reliable pre-tool authorization hook or cancellation boundary that can be intercepted by TNA.
>
> 1. **No pre-tool callback:** SDK does not fire a hook BEFORE tool execution
> 2. **No cancellation boundary:** Cannot cancel in-flight tool call from control plane  
> 3. **No session lifecycle events:** No structured start/cancel/complete events

**The TNA mediation path (Gate → Capability → Sentinel → Broker → Ledger) is REAL and tested.**  
The vendor interception point uses a test harness — clearly marked as such.

When Anthropic SDK exposes proper pre-tool hooks, replace `AnthropicTestHarness` with real implementation.

---

## 7. Real Vendor Model Producer

Extended `packages/model-adapter/src/index.ts`:

```typescript
interface ProducerResult {
  // ... existing fields ...
  vendor_metadata?: {
    vendor_request_id: string | null;
    response_id: string | null;
    model_snapshot: string | null;
    stop_reason: string | null;
  };
}

interface ModelProducer {
  produce(atom: AtomSpec, context: ProducerContext): Promise<ProducerResult>;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
}
```

**Registered producers:**
- `DeterministicMockProvider` (unchanged, for deterministic tests)
- `AnthropicProducer` (test harness — reports actual observable metadata)
- `OpenAIProducer` / `XAIProducer` (`NOT_IMPLEMENTED`)

**UNKNOWN / UNAVAILABLE fields remain explicit** — no manufactured data.

---

## 8. Vendor Provenance in Ledger

Extended `ledger-schema` `AuthorityContext` and `ExecutionContext`:

```typescript
interface AuthorityContext {
  // ... existing ...
  vendor?: string;
  vendor_session_id?: string;
  vendor_request_id?: string;
  vendor_tool_call_id?: string | null;
  model_identifier?: string;
  model_snapshot?: string;
  normalized_action_hash?: string;
}

interface ExecutionContext {
  // ... existing ...
  vendor?: string;
  vendor_session_id?: string;
  vendor_request_id?: string;
  vendor_tool_call_id?: string | null;
  model_identifier?: string;
  model_snapshot?: string;
  capability_id?: string;
}
```

`PlatformLedgerDispatcher.toLedgerEvent()` now includes vendor provenance from action metadata for causal chain reconstruction.

---

## 9. Sentinel Cancellation / Session Containment

`VendorAdapterRuntime.cancelVendorSessionWithSentinel()`:

```typescript
async cancelVendorSessionWithSentinel(
  vendor: string,
  vendor_session_id: string,
  sentinel_session_id: string,
  reason: string,
  mode: 'terminate' | 'hold' = 'terminate'
): Promise<CancellationResult & { sentinel_outcome: 'TERMINATED' | 'HELD' | 'INDETERMINATE' }>
```

- Tries vendor-native cancellation first (if supported)
- **Then enforces Sentinel containment** (authoritative for TNA)
- Records: `cancel_requested`, `cancel_acknowledged`, `cancel_failed`, `cancel_unavailable`
- **Never represents cancel as proof that earlier external effect was undone**

---

## 10. Fail-Closed Behavior

For consequential actions on governed adapter path:

| Failure Condition | Behavior |
|-------------------|----------|
| Gate unavailable | DO NOT EXECUTE |
| Capability issuance fails | DO NOT EXECUTE |
| Capability validation fails | DO NOT EXECUTE |
| Normalized action differs after approval | DO NOT EXECUTE |
| Tenant identity unresolved | DO NOT EXECUTE |
| Adapter cannot determine if governed | HOLD / FAIL CLOSED |
| Downstream credentials missing | DO NOT EXECUTE |

**Never silently falls back to direct vendor execution.**

---

## 11. Packages Created

| Package | Purpose |
|---------|---------|
| `vendor-adapter-core` | Contracts, normalization, adapters (Anthropic, OpenAI, xAI) |
| `vendor-adapter-runtime` | Integration with Platform, Gate, Broker, Sentinel, Ledger |

---

## 12. Frozen Components (Volumes 1–13) — UNCHANGED

| Component | Verification |
|-----------|--------------|
| Gate | ALLOW/BLOCK/HOLD semantics preserved |
| Capability | Exact-call, single-use, TTL-bound, HMAC-SHA256 |
| Sentinel | Session lifecycle, observation types, decision precedence |
| Ledger | Event structure, causation_id fixed at enqueue |
| VAD | Atom spec, producer contract, validation gate |
| Auditor | Assessment model, evidence model, trust closure |
| Platform | Action state machine, orchestration |
| MCP Gateway | Stdio client, bounded timeouts, credential lease |
| Execution Broker | Capability issuance/redeem, secret broker |
| Agent Identity | Principal types, registration |
| Shared Schema | AuthorizationRequest, Decision types |

---

## 13. Known Limitations

1. **Anthropic pre-tool hook unavailable** — test harness used (documented)
2. **Vendor cancellation not universally supported** — `cancel_unavailable` reported honestly
3. **Usage telemetry supplemental** — not replacing existing budget semantics
4. **Computer-use governance not solved** — interface defined, conservative HOLD for high-risk GUI
5. **OpenAI/xAI adapters stubbed** — `NOT_IMPLEMENTED` by design

---

## 14. Verification

Run full verification:
```bash
npm run check  # typecheck + lint + test (1117 pass, 3 skipped)
```

Test categories:
- Adapter unit tests
- Normalization equivalence tests  
- Capability-binding tests
- Credential-bypass tests (16 negative/abuse vectors)
- Real vendor integration test (test harness)
- Platform/Gate/Sentinel/Ledger/VAD regression tests